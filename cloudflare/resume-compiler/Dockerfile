# Pinned TeX Live image; the compiler has no runtime network access.
FROM ghcr.io/xu-cheng/texlive-full:20260701@sha256:d9bfb267e3e3f5e0820ca86e867ee59ebb133fc29561bb28677d9b5a1a9e84ff
WORKDIR /srv
COPY server.py /srv/server.py
EXPOSE 8080
CMD ["python3", "/srv/server.py"]
