import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
INVOKE = os.path.join(HERE, "invoke.py")
KEY = "sk-test-0123456789abcdefSECRET"

RECEIVED = []  # (path, headers dict, body dict) of every request the stub saw


class Stub(BaseHTTPRequestHandler):
    """Implements both protocols. The first path segment picks the behaviour."""

    def log_message(self, *a):
        pass

    def _send(self, code, obj):
        raw = obj if isinstance(obj, bytes) else json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        hdrs = {k.lower(): v for k, v in self.headers.items()}
        RECEIVED.append((self.path, hdrs, None))
        mode = self.path.split("/")[1]
        if mode == "e401":
            return self._send(401, {"error": "bad key"})
        if mode == "echo":
            return self._send(200, {"data": [{"id": "leak-" + str(hdrs.get("authorization"))}]})
        if mode == "badjson":
            return self._send(200, b"not json")
        if self.path.endswith("/models"):
            return self._send(200, {"object": "list", "data": [{"id": "model-a"}, {"id": "model-b", "object": "model"}, {"nope": 1}]})
        self._send(404, {})

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        hdrs = {k.lower(): v for k, v in self.headers.items()}
        RECEIVED.append((self.path, hdrs, body))
        mode = self.path.split("/")[1]
        if mode == "e401":
            return self._send(401, {"error": "bad key"})
        if mode == "e429":
            return self._send(429, {"error": "slow down"})
        if mode == "e500":
            return self._send(500, {"error": "boom " + "x" * 500})
        if mode == "echo":  # leaks the credentials it was given inside an error body
            leak = "got Authorization: %s x-api-key: %s" % (hdrs.get("authorization"), hdrs.get("x-api-key"))
            return self._send(500, {"error": leak})
        if mode == "slow":
            time.sleep(3)
            return self._send(200, {})
        if mode == "nousage":
            return self._send(200, {"choices": [{"message": {"content": [{"type": "text", "text": "no usage"}]}}]})
        if mode == "badjson":
            return self._send(200, b"not json")
        if self.path.endswith("/chat/completions"):
            return self._send(200, {"choices": [{"message": {"role": "assistant", "content": "openai says hi"}}],
                                    "usage": {"prompt_tokens": 7, "completion_tokens": 3}})
        if self.path.endswith("/v1/messages"):
            return self._send(200, {"content": [{"type": "text", "text": "anthropic says hi"}],
                                    "usage": {"input_tokens": 11, "output_tokens": 5}})
        self._send(404, {})


class InvokeCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = HTTPServer(("127.0.0.1", 0), Stub)
        cls.port = cls.srv.server_address[1]
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.srv.server_close()

    def setUp(self):
        RECEIVED.clear()
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.prompt = os.path.join(self.tmp.name, "prompt.txt")
        with open(self.prompt, "w") as f:
            f.write("say hi")

    def base(self, mode):
        return "http://127.0.0.1:%d/%s" % (self.port, mode)

    def run_invoke(self, registry, *args, key=KEY, extra_env=None):
        with open(os.path.join(self.tmp.name, "spick.json"), "w") as f:
            json.dump({"lane_registry": registry}, f)
        env = {k: v for k, v in os.environ.items() if "proxy" not in k.lower() and k != "SPICK_TEST_KEY"}
        env.update({"CLAUDE_CONFIG_DIR": self.tmp.name, "NO_PROXY": "127.0.0.1"})
        if key is not None:
            env["SPICK_TEST_KEY"] = key
        env.update(extra_env or {})
        argv = [sys.executable, INVOKE, "--prompt-file", self.prompt] + list(args)
        return subprocess.run(argv, capture_output=True, text=True, env=env, timeout=60)

    def api_lane(self, api="openai-chat", mode="ok", **over):
        lane = {"kind": "api-key", "key_ref": "env:SPICK_TEST_KEY", "data": "text",
                "invoke": {"api": api, "base_url": self.base(mode), "model": "m1"}}
        lane.update(over)
        return {"t": lane}


class Protocols(InvokeCase):
    def test_openai_chat_happy_path(self):
        sysf = os.path.join(self.tmp.name, "sys.txt")
        with open(sysf, "w") as f:
            f.write("be brief")
        r = self.run_invoke(self.api_lane(), "--lane", "t", "--system-file", sysf, "--max-tokens", "50")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout, "openai says hi\n")
        self.assertRegex(r.stderr, r"^spick-invoke: t m1 7 in / 3 out tokens, [\d.]+s\n$")
        path, hdrs, body = RECEIVED[0]
        self.assertEqual(path, "/ok/chat/completions")
        self.assertEqual(hdrs["authorization"], "Bearer " + KEY)
        self.assertEqual(body["model"], "m1")
        self.assertEqual(body["max_tokens"], 50)
        self.assertEqual(body["messages"], [{"role": "system", "content": "be brief"}, {"role": "user", "content": "say hi"}])

    def test_anthropic_messages_happy_path(self):
        sysf = os.path.join(self.tmp.name, "sys.txt")
        with open(sysf, "w") as f:
            f.write("be brief")
        r = self.run_invoke(self.api_lane("anthropic-messages"), "--lane", "t", "--system-file", sysf, "--model", "m2")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout, "anthropic says hi\n")
        self.assertRegex(r.stderr, r"spick-invoke: t m2 11 in / 5 out tokens, [\d.]+s")
        path, hdrs, body = RECEIVED[0]
        self.assertEqual(path, "/ok/v1/messages")
        self.assertEqual(hdrs["x-api-key"], KEY)
        self.assertEqual(hdrs["anthropic-version"], "2023-06-01")
        self.assertNotIn("authorization", hdrs)
        self.assertEqual(body["model"], "m2")
        self.assertEqual(body["system"], "be brief")
        self.assertEqual(body["messages"], [{"role": "user", "content": "say hi"}])
        self.assertIn("max_tokens", body)

    def test_key_never_in_argv_or_output_on_success(self):
        r = self.run_invoke(self.api_lane(), "--lane", "t")
        self.assertNotIn(KEY, r.stdout + r.stderr)

    def test_local_lane_without_key_ref_sends_no_credentials(self):
        reg = {"loc": {"kind": "local", "invoke": {"api": "openai-chat", "base_url": self.base("ok"), "model": "q"}}}
        r = self.run_invoke(reg, "--lane", "loc", key=None)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertNotIn("authorization", RECEIVED[0][1])

    def test_tokens_unknown_when_usage_missing(self):
        r = self.run_invoke(self.api_lane(mode="nousage"), "--lane", "t", "--model", "m9")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout, "no usage\n")
        self.assertRegex(r.stderr, r"spick-invoke: t m9 tokens unknown, [\d.]+s")


class Failures(InvokeCase):
    def test_401_exits_3(self):
        r = self.run_invoke(self.api_lane(mode="e401"), "--lane", "t")
        self.assertEqual(r.returncode, 3)

    def test_429_exits_4(self):
        self.assertEqual(self.run_invoke(self.api_lane(mode="e429"), "--lane", "t").returncode, 4)

    def test_500_exits_5_and_body_is_truncated(self):
        r = self.run_invoke(self.api_lane(mode="e500"), "--lane", "t")
        self.assertEqual(r.returncode, 5)
        self.assertLess(len(r.stderr), 330)

    def test_bad_json_exits_5(self):
        self.assertEqual(self.run_invoke(self.api_lane(mode="badjson"), "--lane", "t").returncode, 5)

    def test_timeout_exits_5(self):
        r = self.run_invoke(self.api_lane(mode="slow"), "--lane", "t", "--timeout", "1")
        self.assertEqual(r.returncode, 5)

    def test_connection_refused_exits_5(self):
        lane = self.api_lane()
        lane["t"]["invoke"]["base_url"] = "http://127.0.0.1:1"
        self.assertEqual(self.run_invoke(lane, "--lane", "t").returncode, 5)

    def test_echoed_credentials_never_reach_output(self):
        for api in ("openai-chat", "anthropic-messages"):
            RECEIVED.clear()
            r = self.run_invoke(self.api_lane(api, mode="echo"), "--lane", "t")
            self.assertEqual(r.returncode, 5)
            self.assertNotIn(KEY, r.stdout + r.stderr)
            self.assertNotIn("sk-test", r.stdout + r.stderr)

    def test_redirect_is_not_followed(self):
        # a 3xx must not carry the key anywhere: it is reported as an error
        class Redir(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_POST(self):
                self.rfile.read(int(self.headers.get("Content-Length", 0)))
                self.send_response(307)
                self.send_header("Location", "http://127.0.0.1:1/x")
                self.send_header("Content-Length", "0")
                self.end_headers()
        srv = HTTPServer(("127.0.0.1", 0), Redir)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        self.addCleanup(srv.server_close)
        self.addCleanup(srv.shutdown)
        lane = self.api_lane()
        lane["t"]["invoke"]["base_url"] = "http://127.0.0.1:%d" % srv.server_address[1]
        r = self.run_invoke(lane, "--lane", "t")
        self.assertEqual(r.returncode, 5)
        self.assertNotIn(KEY, r.stdout + r.stderr)


class Refusals(InvokeCase):
    def test_web_only_exits_3(self):
        reg = {"site": {"kind": "web-only"}}
        r = self.run_invoke(reg, "--lane", "site")
        self.assertEqual(r.returncode, 3)
        self.assertIn("lane site is web-only and cannot be called; paste the prompt into the site yourself", r.stderr)
        self.assertEqual(r.stdout, "")

    def test_missing_key_env_exits_3_naming_only_the_variable(self):
        r = self.run_invoke(self.api_lane(), "--lane", "t", key=None)
        self.assertEqual(r.returncode, 3)
        self.assertIn("key not found: env SPICK_TEST_KEY", r.stderr)
        self.assertEqual(r.stdout, "")

    def test_missing_keychain_item_exits_3_naming_only_the_item(self):
        lane = self.api_lane(key_ref="keychain:spick-no-such-item-xyz")
        r = self.run_invoke(lane, "--lane", "t")
        self.assertEqual(r.returncode, 3)
        self.assertIn("key not found: keychain spick-no-such-item-xyz", r.stderr)
        self.assertEqual(RECEIVED, [])

    def test_keychain_without_security_tool_says_macos_only(self):
        lane = self.api_lane(key_ref="keychain:spick-no-such-item-xyz")
        r = self.run_invoke(lane, "--lane", "t", extra_env={"PATH": ""})
        self.assertEqual(r.returncode, 3)
        self.assertIn("macOS only", r.stderr)
        self.assertIn("env:<VAR>", r.stderr)
        self.assertEqual(RECEIVED, [])

    def test_api_lane_without_key_ref_exits_3(self):
        lane = self.api_lane()
        del lane["t"]["key_ref"]
        r = self.run_invoke(lane, "--lane", "t")
        self.assertEqual(r.returncode, 3)
        self.assertEqual(RECEIVED, [])

    def test_unknown_lane_exits_2(self):
        self.assertEqual(self.run_invoke({}, "--lane", "nope").returncode, 2)

    def test_missing_arguments_exit_2(self):
        r = subprocess.run([sys.executable, INVOKE], capture_output=True, text=True)
        self.assertEqual(r.returncode, 2)

    def test_lane_without_invoke_exits_2(self):
        self.assertEqual(self.run_invoke({"bare": {"kind": "api-key"}}, "--lane", "bare").returncode, 2)

    def test_builtin_pointer_is_not_run_as_a_command(self):
        self.assertEqual(self.run_invoke({}, "--lane", "gemini").returncode, 2)


class ListModels(InvokeCase):
    def test_lists_ids_one_per_line_without_a_prompt_file(self):
        r = self.run_invoke(self.api_lane(), "--lane", "t", "--list-models")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout, "model-a\nmodel-b\n")
        self.assertEqual(RECEIVED[0][0], "/ok/models")

    def test_auth_header_sent_and_key_never_printed(self):
        r = self.run_invoke(self.api_lane(), "--lane", "t", "--list-models")
        self.assertEqual(RECEIVED[0][1]["authorization"], "Bearer " + KEY)
        self.assertNotIn(KEY, r.stdout + r.stderr)

    def test_key_echoed_inside_an_id_is_redacted(self):
        r = self.run_invoke(self.api_lane(mode="echo"), "--lane", "t", "--list-models")
        self.assertNotIn(KEY, r.stdout + r.stderr)

    def test_401_exits_3(self):
        r = self.run_invoke(self.api_lane(mode="e401"), "--lane", "t", "--list-models")
        self.assertEqual(r.returncode, 3)
        self.assertEqual(r.stdout, "")
        self.assertNotIn(KEY, r.stderr)

    def test_missing_key_exits_3_without_a_request(self):
        r = self.run_invoke(self.api_lane(), "--lane", "t", "--list-models", key=None)
        self.assertEqual(r.returncode, 3)
        self.assertEqual(RECEIVED, [])

    def test_local_lane_without_key_sends_no_credentials(self):
        reg = {"loc": {"kind": "local", "invoke": {"api": "openai-chat", "base_url": self.base("ok"), "model": "q"}}}
        r = self.run_invoke(reg, "--lane", "loc", "--list-models", key=None)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertNotIn("authorization", RECEIVED[0][1])

    def test_anthropic_lane_exits_2(self):
        r = self.run_invoke(self.api_lane("anthropic-messages"), "--lane", "t", "--list-models")
        self.assertEqual(r.returncode, 2)
        self.assertEqual(RECEIVED, [])

    def test_bad_json_exits_5(self):
        self.assertEqual(self.run_invoke(self.api_lane(mode="badjson"), "--lane", "t", "--list-models").returncode, 5)

    def test_prompt_file_still_required_for_a_normal_call(self):
        with open(os.path.join(self.tmp.name, "spick.json"), "w") as f:
            json.dump({"lane_registry": self.api_lane()}, f)
        env = dict(os.environ, CLAUDE_CONFIG_DIR=self.tmp.name, SPICK_TEST_KEY=KEY)
        r = subprocess.run([sys.executable, INVOKE, "--lane", "t"], capture_output=True, text=True, env=env)
        self.assertEqual(r.returncode, 2)


class Contains(InvokeCase):
    def test_lower_data_level_warns_and_still_proceeds(self):
        r = self.run_invoke(self.api_lane(data="public"), "--lane", "t", "--contains", "code")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout, "openai says hi\n")
        self.assertIn("warning", r.stderr)
        self.assertEqual(len([l for l in r.stderr.splitlines() if "warning" in l]), 1)

    def test_no_warning_when_level_is_enough_or_unset(self):
        r = self.run_invoke(self.api_lane(data="code"), "--lane", "t", "--contains", "text")
        self.assertNotIn("warning", r.stderr)
        lane = self.api_lane()
        del lane["t"]["data"]
        r = self.run_invoke(lane, "--lane", "t", "--contains", "code")
        self.assertEqual(r.returncode, 0)
        self.assertNotIn("warning", r.stderr)


class Cli(InvokeCase):
    def test_template_with_prompt_file_is_substituted_and_run_without_a_shell(self):
        reg = {"c": {"kind": "cli-subscription", "invoke": {"cli": "cat {prompt_file}"}}}
        r = self.run_invoke(reg, "--lane", "c")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout, "say hi\n")
        self.assertIn("spick-invoke: c cli tokens unknown", r.stderr)

    def test_no_shell_interpretation(self):
        reg = {"c": {"kind": "cli-subscription", "invoke": {"cli": "echo {prompt_file} ; echo pwned"}}}
        r = self.run_invoke(reg, "--lane", "c")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("; echo pwned", r.stdout)
        self.assertEqual(r.stdout.count("pwned"), 1)

    def test_prompt_on_stdin_when_template_has_no_placeholder(self):
        reg = {"c": {"kind": "cli-subscription", "invoke": {"cli": "cat"}}}
        r = self.run_invoke(reg, "--lane", "c")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout, "say hi\n")

    def test_failing_command_exits_5(self):
        reg = {"c": {"kind": "cli-subscription", "invoke": {"cli": "false"}}}
        self.assertEqual(self.run_invoke(reg, "--lane", "c").returncode, 5)

    def test_missing_command_exits_5(self):
        reg = {"c": {"kind": "cli-subscription", "invoke": {"cli": "spick-no-such-binary {prompt_file}"}}}
        self.assertEqual(self.run_invoke(reg, "--lane", "c").returncode, 5)


if __name__ == "__main__":
    unittest.main()
