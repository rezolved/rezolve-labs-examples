# Rezolve Labs examples

Runnable code for the [Rezolve Labs site-assistant playbook](https://rezolvelabs.com/docs/getting-started/playbook-start-here).
Each file runs on its own and shows one idea; the playbook quotes these files. Server code comes in Python and
TypeScript, and both print the same output. See [`examples/README.md`](examples/README.md) for every example.

```bash
cp env.example .env          # put your secret key in LABS_API_KEY
cd examples && uv sync && npm install
uv run python getting-started/01-verify-key.py
```
