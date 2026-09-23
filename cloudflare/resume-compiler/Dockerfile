# Keep the runtime below the basic container's 4 GB disk limit. The full TeX
# Live image expands to almost 8 GB even though this fixed template only needs
# core LaTeX, geometry, and the standard T1 fonts.
FROM alpine:3.22@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8
RUN apk add --no-cache poppler-utils python3 texlive
WORKDIR /srv
COPY server.py /srv/server.py
EXPOSE 8080
CMD ["python3", "/srv/server.py"]
