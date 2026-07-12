import os, sys, json, time, base64
from google import genai
from google.genai import types
from google.oauth2.credentials import Credentials
from playwright.sync_api import sync_playwright

GOAL=os.environ["GOAL"]; START=os.environ.get("START_URL","about:blank")
ALLOWED=[d.strip().lower() for d in os.environ.get("ALLOWED_DOMAINS","").split(",") if d.strip()]
MAX=int(os.environ.get("MAX_STEPS","8")); OUT=os.environ["OUT_DIR"]; TOKEN=os.environ["CU_TOKEN"]
MODEL="gemini-2.5-computer-use-preview-10-2025"
os.makedirs(OUT, exist_ok=True); log=[]
DENY=("password","login","sign in","credit card","checkout","purchase","2fa","otp")

def host_ok(url):
    from urllib.parse import urlparse
    h=(urlparse(url).hostname or "").lower()
    return any(h==d or h.endswith("."+d) for d in ALLOWED) if ALLOWED else False

client=genai.Client(vertexai=True, project="YOUR_GCP_PROJECT", location="global",
                    credentials=Credentials(token=TOKEN))
cfg=types.GenerateContentConfig(tools=[types.Tool(computer_use=types.ComputerUse(environment="ENVIRONMENT_BROWSER"))])

with sync_playwright() as p:
    b=p.chromium.launch(headless=True, args=["--no-sandbox","--disable-dev-shm-usage"])
    pg=b.new_page(viewport={"width":1280,"height":900})
    if START!="about:blank":
        if not host_ok(START): print("START_URL blocked by allowlist"); sys.exit(2)
        pg.goto(START, timeout=30000, wait_until="domcontentloaded")
    def shot(i):
        pth=os.path.join(OUT,f"step{i:02d}.png"); pg.screenshot(path=pth); return open(pth,"rb").read()
    contents=[types.Content(role="user", parts=[
        types.Part(text=f"Task: {GOAL}\nYou control a browser. Current URL: {pg.url}"),
        types.Part.from_bytes(data=shot(0), mime_type="image/png")])]
    final=None
    for step in range(1,MAX+1):
        try:
            r=client.models.generate_content(model=MODEL, contents=contents, config=cfg)
        except Exception as e:
            log.append({"step":step,"error":str(e)[:200]}); final=f"model error: {str(e)[:120]}"; break
        cand=r.candidates[0]; parts=cand.content.parts or []
        fcs=[pt.function_call for pt in parts if getattr(pt,"function_call",None)]
        txt="".join(pt.text for pt in parts if getattr(pt,"text",None))
        contents.append(cand.content)
        if not fcs:
            final=txt.strip() or "(model returned no action, no text)"; log.append({"step":step,"done_text":final[:300]}); break
        # execute first function call
        fc=fcs[0]; name=fc.name; args=dict(fc.args or {})
        entry={"step":step,"action":name,"args":{k:(str(v)[:60]) for k,v in args.items()}}
        blob=json.dumps(args).lower()+(txt or "").lower()
        refused=None
        if any(w in blob for w in DENY): refused="denied action (credentials/financial/login policy)"
        W,H=1280,900
        def px(a,b): return int(float(a)/1000*W), int(float(b)/1000*H)
        try:
            if refused: pass
            elif name in ("open_web_browser","wait_5_seconds"): time.sleep(1)
            elif name=="navigate":
                u=args.get("url","");
                if not host_ok(u): refused=f"navigate blocked: {u} not in allowlist"
                else: pg.goto(u, timeout=30000, wait_until="domcontentloaded")
            elif name=="go_back": pg.go_back()
            elif name in ("click_at","hover_at","double_click_at"):
                x,y=px(args.get("x",0),args.get("y",0))
                (pg.mouse.dblclick if name=="double_click_at" else (pg.mouse.move if name=="hover_at" else pg.mouse.click))(x,y)
            elif name=="type_text_at":
                x,y=px(args.get("x",0),args.get("y",0)); pg.mouse.click(x,y); pg.keyboard.type(args.get("text","")[:200])
            elif name in ("scroll_document","scroll_at"):
                pg.mouse.wheel(0, 600 if "down" in blob else -600)
            elif name=="key_combination": pg.keyboard.press(args.get("keys","Enter").replace("+","+"))
            else: entry["note"]="unhandled action (skipped)"
        except Exception as e:
            entry["exec_error"]=str(e)[:120]
        if refused: entry["refused"]=refused
        if not host_ok(pg.url) and pg.url not in ("about:blank",) and ALLOWED:
            entry["offdomain_url"]=pg.url
        log.append(entry)
        # return result to model: FunctionResponse with screenshot in parts[].inline_data (CU protocol)
        _png=shot(step)
        _fr=types.FunctionResponse(name=name, response={"url":pg.url,"refused":bool(refused)},
            parts=[types.FunctionResponsePart(inline_data=types.FunctionResponseBlob(mime_type="image/png", data=_png))])
        contents.append(types.Content(role="user", parts=[types.Part(function_response=_fr)]))
    b.close()

res={"goal":GOAL,"final":final,"steps_used":len([e for e in log if 'action' in e or 'done_text' in e]),"final_url":None,"log":log,"ts":time.strftime("%Y-%m-%dT%H:%M:%SZ")}
open(os.path.join(OUT,"result.json"),"w").write(json.dumps(res,indent=2))
open(os.path.join(OUT,"result.md"),"w").write(f"# browser_job result\n- goal: {GOAL}\n- final: {final}\n- steps: {res['steps_used']}\n")
print("FINAL:", (final or "")[:200]); print("steps:", res["steps_used"])
