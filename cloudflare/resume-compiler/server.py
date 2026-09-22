import http.server
import os
import resource
import subprocess
import tempfile

MAX_PDF_BYTES = 2 * 1024 * 1024

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
            self.send_response(200); self.send_header('Content-Type', 'application/pdf'); self.send_header('Content-Length', str(len(data))); self.end_headers(); self.wfile.write(data)

    def log_message(self, *_): pass

http.server.ThreadingHTTPServer(('0.0.0.0', 8080), Compiler).serve_forever()
