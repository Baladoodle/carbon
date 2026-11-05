# Cloud agents and credentials

The repository contains all code, coverage boards and example prompts needed for asset work.
Install the tool in the cloud workspace from the checked-out branch:

```sh
python -m venv .venv
.venv/bin/python -m pip install './tools/genforge[test]'
.venv/bin/python tools/genforge --help
```

On Windows the interpreter is `.venv\Scripts\python.exe`. Planning, importing, filtering and
tests need no key. Image execution needs HTTPS access to `api.openai.com` on port 443 and an
`OPENAI_API_KEY` value in the executing process. Requests use the fixed OpenAI origin and the
standard HTTPS proxy environment, with no automatic retries.

## Current Codex Cloud

In the environment configuration, add a **network secret** with key `OPENAI_API_KEY` and allowed
domain `api.openai.com`, then publish the environment and start a task using it. Do not also
define a direct environment variable with the same key. Codex supplies a placeholder to the
process and substitutes the credential in HTTPS requests to the allowed destination; this
tool sends it in the standard Authorization header. The API key need not enter the repository
or a local file. This setup follows the official
[environment variables and network secrets documentation](https://learn.chatgpt.com/docs/environments/cloud-environments#configure-environment-variables-and-network-secrets).

If you use the **legacy** setup-script environment, its Secrets are available during setup
only and are removed before the agent phase. A shell `export` in setup is not persistent
either. Do not assume an agent can generate just because setup saw a key. Use a runtime
credential channel supported by your environment, or generate from a trusted local workspace.
See the official [legacy environments documentation](https://learn.chatgpt.com/docs/environments/cloud-environment#environment-variables-and-secrets).

## Other cloud runtimes

Inject `OPENAI_API_KEY` using that runtime's environment/secret settings for the **execution**
phase. Enable outbound API access there. A secret configured in GitHub Actions or in a local
shell is not automatically available to another cloud agent.

The default model matches Genforge, `gpt-image-2.5-flare`. `--model` or
`GENFORGE_IMAGE_MODEL` can select a model your API project actually has access to. Provider
limits and prices remain external; see the official
[Images API](https://developers.openai.com/api/reference/resources/images/methods/edit).

## Local `.env`

Copy `tools/genforge/.env.example` to the repository root as `.env`, then put the key there
locally. Root `.env`, nested `.env` and `.env.*` files are ignored; only `.env.example` is
tracked. Environment values override the file. Another file is explicit:

```sh
python tools/genforge --env-file /path/to/private.env run assets/generated/meadow --yes --max-calls 3
```

The loader reads literal assignments for `OPENAI_API_KEY` and `GENFORGE_IMAGE_MODEL` only;
it never sources shell code. A private Git repository still distributes a committed key to
every clone and retains it in history. There is no need to make credential rotation depend
on rewriting asset history.

The CLI never prints Authorization headers or provider error bodies. Plans, receipts and
provenance store prompts, file hashes, provider usage and request IDs, never credentials.
Tests use fake transports and explicitly reject real provider access. This PR verifies the
transport shape and offline pipeline; it does not configure a hosted environment or make a
live paid generation request.
