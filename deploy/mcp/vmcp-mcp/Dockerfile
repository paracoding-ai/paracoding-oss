FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY heuristics.py proxy.py ./
ENV PORT=8080
EXPOSE 8080
CMD ["sh","-c","exec uvicorn proxy:app --host 0.0.0.0 --port ${PORT:-8080} --no-access-log"]
