# Hardened deploy-runner image. Our built image is digest-pinned at deploy time
# (the Cloud Run Job runs ONLY that @sha256 digest, and runner.py self-asserts it).
# Base is cloud-sdk:slim (bash + gcloud + python3). Pinning the BASE by digest is a
# noted follow-up hardening.
FROM gcr.io/google.com/cloudsdktool/cloud-sdk:slim
RUN pip3 install --no-cache-dir --break-system-packages google-cloud-firestore google-cloud-storage \
 || pip3 install --no-cache-dir google-cloud-firestore google-cloud-storage
COPY runner.py /app/runner.py
ENTRYPOINT ["python3","/app/runner.py"]
