"""Exercise the CLI against a loopback-only mock service."""
import http.server
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest

CLI = Path(__file__).resolve().parents[1] / "cli/folder-sync"


class ClientTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.result_status = "partial"
        self.redirect = False
        test = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def respond(self, data):
                if self.headers.get("Authorization") != "Bearer synthetic-token":
                    self.send_error(401)
                    return
                body = json.dumps(data).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                if test.redirect:
                    self.send_response(302)
                    self.send_header("Location", "https://example.invalid/credential-sink")
                    self.end_headers()
                    return
                if self.path.endswith("/health"):
                    self.respond({"plugin": "zotero-folder-sync", "protocol": 2})
                elif "/jobs/" in self.path:
                    self.respond({"id": "fixture", "status": test.result_status})
                else:
                    self.respond({"rules": []})

            def do_POST(self):
                self.rfile.read(int(self.headers.get("Content-Length", 0)))
                self.respond({"id": "fixture", "status": "queued"})

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        self.connection = self.root / "connection.json"
        token = self.root / "token"
        token.write_text("synthetic-token")
        self.connection.write_text(json.dumps({"plugin": "zotero-folder-sync", "protocol": 2,
            "base": f"http://127.0.0.1:{server.server_address[1]}/folder-sync/v2", "tokenPath": str(token)}))

    def run_cli(self, *arguments, expected=0, **environment):
        result = subprocess.run([sys.executable, str(CLI), "--connection", str(self.connection), *arguments],
            capture_output=True, text=True, env={**os.environ, **environment})
        self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
        return result

    def test_proxy_is_bypassed_for_loopback(self):
        self.run_cli("doctor", HTTP_PROXY="http://127.0.0.1:1", http_proxy="http://127.0.0.1:1")

    def test_partial_failure_has_nonzero_exit(self):
        result = self.run_cli("apply", "--plan", "fixture", expected=1)
        self.assertEqual(json.loads(result.stdout)["status"], "partial")

    def test_completed_job_has_zero_exit(self):
        self.result_status = "succeeded"
        self.run_cli("apply", "--plan", "fixture")

    def test_remote_endpoint_cannot_receive_token(self):
        configuration = json.loads(self.connection.read_text())
        configuration["base"] = "https://example.invalid/folder-sync/v2"
        self.connection.write_text(json.dumps(configuration))
        result = self.run_cli("doctor", expected=2)
        self.assertIn("loopback", result.stderr)

    def test_redirect_cannot_forward_credentials(self):
        self.redirect = True
        result = self.run_cli("doctor", expected=2)
        self.assertIn("refusing to forward credentials", result.stderr)

    def test_timeout_and_scope_selection(self):
        self.result_status = "running"
        self.run_cli("--timeout", "0.1", "apply", "--plan", "fixture", expected=2)
        self.run_cli("--timeout", "nan", "doctor", expected=2)
        self.run_cli("plan", expected=2)


if __name__ == "__main__":
    unittest.main()
