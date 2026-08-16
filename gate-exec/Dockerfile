FROM gcr.io/google.com/cloudsdktool/cloud-sdk:slim
# [SEC-ARGROWTH-V1] THE MTIME NORMALISE IS WHY THIS LAYER STOPS COSTING STORAGE, AND IT
# HAS TO STAY INSIDE THIS RUN. This is the SECOND package in the same Artifact Registry
# repository as the control plane and it carried the identical defect, so it gets the
# identical treatment. Artifact Registry deduplicates by LAYER DIGEST, and a layer digest
# is the sha256 of a tar that carries a per-entry mtime. MEASURED on the control plane and
# true of any unpinned installer: the package manager stamps every extracted file with the
# WALL-CLOCK INSTALL TIME rather than the package's own mtime, so two installs of an
# IDENTICAL dependency tree emit two different layer digests and the registry stores both.
# A build cache would also hide this, and there is no reachable one: every build path in
# this tree is `gcloud run deploy --source`, which submits its own build and accepts no
# docker build flags, so --cache-from and kaniko are both unavailable here.
#
# AS ITS OWN RUN IT WOULD MAKE THINGS WORSE. Rewriting an mtime marks a file CHANGED, so a
# separate layer would carry a SECOND full copy of site-packages rather than deduplicating
# the first. One RUN, or nothing.
#
# PYTHON NEEDS ONE THING NODE DID NOT, AND WITHOUT IT THE TOUCH DOES NOT WORK AT ALL HERE.
# MEASURED, not reasoned: pip byte-compiles what it installs, and a .pyc in the default
# TIMESTAMP invalidation mode carries the source mtime INSIDE ITS OWN HEADER. Normalising
# mtimes alone therefore fails twice over. It leaves every .pyc stale, so the interpreter
# recompiles the whole imported dependency tree on every cold start -- confirmed by
# observing the .pyc rewritten on the next import. And it does not even fix the digest,
# because the .pyc CONTENT still moves: the same unchanged source, compiled twice with
# only its mtime differing, produced two different sha256s in TIMESTAMP mode and one
# identical sha256 in hash mode. SOURCE_DATE_EPOCH flips pip's byte-compilation to
# hash-based invalidation (PEP 552), which derives the .pyc from the source BYTES alone.
# Verified in both directions: with the variable the header reads CHECKED_HASH and a
# re-import after the touch does not rewrite the file; without it the header reads
# TIMESTAMP and the import rewrites it. Only the PRESENCE of the variable selects the
# mode, never its value, so it cannot drift out of step with the touch below and no
# timezone difference between build hosts can desynchronise the two.
#
# THE PATH IS DERIVED, NOT GUESSED, because pip's install target is not fixed by this file
# the way WORKDIR fixes npm's. It is read back out of the interpreter this image actually
# runs, from a package that was just installed, so the directory normalised is by
# construction the one the install wrote and the runtime imports. If the install ever goes
# somewhere python3 cannot see, the substitution is empty, find refuses the empty path and
# THE BUILD FAILS. That is deliberate: a normalisation that quietly does nothing is
# precisely the failure this line exists to prevent, and it would be invisible for as long
# as nobody watched the repository size. /usr/local/bin is named as a literal beside it
# because that is where this base image's pip writes console scripts; a base image whose
# pip wrote them elsewhere would leave those few small files un-normalised, which is a
# residual and is recorded here rather than hidden.
#
# 198510260815 is npm's own fixed pack epoch, kept identical to the control plane's so both
# images in this repository normalise to the same instant. -h touches a symlink itself
# instead of following it, so a dangling link cannot fail the build.
RUN SOURCE_DATE_EPOCH=499162500 pip3 install --no-cache-dir --break-system-packages flask google-cloud-firestore cryptography || SOURCE_DATE_EPOCH=499162500 pip3 install --no-cache-dir flask google-cloud-firestore cryptography && find "$(python3 -c 'import flask, os; print(os.path.dirname(os.path.dirname(flask.__file__)))')" /usr/local/bin -exec touch -h -t 198510260815 {} +
# [SEC-MINTER-V1] the minter needs its verifier and its signing client in the image;
# copying only exec_server.py shipped a service that imported modules that were not there.
COPY exec_server.py /app/exec_server.py
COPY pcwebauthn.py /app/pcwebauthn.py
COPY pcmint.py /app/pcmint.py
# [GCP-LOCKOUT-CHECK-V1] the pre-execute lockout checker. exec_server.py imports it and
# FAILS CLOSED if it is absent, so omitting this line does not ship a service that skips
# the check -- it ships one that refuses every job. That is the intended direction.
COPY lockout_check.py /app/lockout_check.py
WORKDIR /app
ENV PORT=8080
CMD ["python3", "exec_server.py"]
