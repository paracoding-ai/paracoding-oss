FROM gcr.io/google.com/cloudsdktool/cloud-sdk:slim
RUN pip3 install --no-cache-dir --break-system-packages flask google-cloud-firestore cryptography \
 || pip3 install --no-cache-dir flask google-cloud-firestore cryptography
# [SEC-MINTER-V1] the minter needs its verifier and its signing client in the image;
# copying only exec_server.py shipped a service that imported modules that were not there.
COPY exec_server.py /app/exec_server.py
COPY pcwebauthn.py /app/pcwebauthn.py
COPY pcmint.py /app/pcmint.py
WORKDIR /app
ENV PORT=8080
CMD ["python3", "exec_server.py"]
