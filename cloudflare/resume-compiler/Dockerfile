# Pinned TeX Live image; the compiler has no runtime network access.
FROM ghcr.io/xu-cheng/texlive-full:2024.20240311
WORKDIR /srv
COPY server.py /srv/server.py
EXPOSE 8080
CMD ["python3", "/srv/server.py"]
