import http.server
import os
import resource
import subprocess
import tempfile
import zipfile

MAX_PDF_BYTES = 2 * 1024 * 1024
MAX_PREVIEW_BYTES = 2 * 1024 * 1024
MAX_PAGES = 6

class Compiler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/health':
            self.send_response(204); self.end_headers(); return
        self.send_error(404)

    def do_POST(self):
        if self.path != '/compile': self.send_error(404); return
        size = int(self.headers.get('Content-Length', '0'))
        if size <= 0 or size > 256000: self.send_error(413); return
        source = self.rfile.read(size)
        with tempfile.TemporaryDirectory() as directory:
            tex = os.path.join(directory, 'resume.tex')
            with open(tex, 'wb') as output: output.write(source)
            try:
                result = subprocess.run(
                    ['pdflatex', '-no-shell-escape', '-halt-on-error', '-interaction=nonstopmode', '-output-directory', directory, tex],
                    cwd=directory, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                    timeout=20, preexec_fn=lambda: resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_PDF_BYTES, MAX_PDF_BYTES)))
            except (subprocess.TimeoutExpired, OSError):
                self.send_error(422, 'Compilation failed'); return
            pdf = os.path.join(directory, 'resume.pdf')
            if result.returncode != 0 or not os.path.exists(pdf): self.send_error(422, 'Compilation failed'); return
            with open(pdf, 'rb') as output: data = output.read(MAX_PDF_BYTES + 1)
            if len(data) > MAX_PDF_BYTES: self.send_error(413, 'Compiled PDF exceeds limit'); return
            try:
                info = subprocess.run(['pdfinfo', pdf], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=5, check=True)
                page_line = next(line for line in info.stdout.decode('utf-8', 'replace').splitlines() if line.startswith('Pages:'))
                pages = int(page_line.split(':', 1)[1].strip())
                if pages < 1 or pages > MAX_PAGES: self.send_error(413, 'Compiled PDF has too many pages'); return
                previews = []
                for page in range(1, pages + 1):
                    prefix = os.path.join(directory, f'preview-{page}')
                    subprocess.run(['pdftoppm', '-f', str(page), '-l', str(page), '-png', '-r', '96', '-singlefile', pdf, prefix], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5, check=True)
                    with open(f'{prefix}.png', 'rb') as output: preview = output.read(MAX_PREVIEW_BYTES + 1)
                    if len(preview) > MAX_PREVIEW_BYTES: self.send_error(413, 'Preview exceeds limit'); return
                    previews.append(preview)
            except (StopIteration, ValueError, subprocess.SubprocessError, OSError):
                self.send_error(422, 'Could not rasterize PDF preview'); return
            archive = os.path.join(directory, 'artifact.zip')
            with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED) as output:
                output.writestr('resume.pdf', data)
                output.writestr('page-count.txt', str(pages))
                for index, preview in enumerate(previews, start=1): output.writestr(f'preview-{index}.png', preview)
            with open(archive, 'rb') as output: payload = output.read()
            self.send_response(200); self.send_header('Content-Type', 'application/zip'); self.send_header('Content-Length', str(len(payload))); self.end_headers(); self.wfile.write(payload)

    def log_message(self, *_): pass

http.server.ThreadingHTTPServer(('0.0.0.0', 8080), Compiler).serve_forever()
