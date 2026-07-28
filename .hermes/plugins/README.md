# Joshu Hermes Plugins

Project-local Hermes plugins live here.

Example layout:

```text
.hermes/plugins/joshu-browser/
├── plugin.yaml
├── __init__.py
├── schemas.py
└── tools.py
```

Joshu starts Hermes with `HERMES_ENABLE_PROJECT_PLUGINS=true`, so Hermes can
discover plugins from this directory. Discovery does not enable plugins by
itself; add plugin names to `JOSHU_HERMES_PLUGIN_NAMES` or to
`plugins.enabled` in `$HERMES_HOME/config.yaml`.

## joshu-langfuse-relay

Fleet default observability path: posts turn/tool events to the control plane
(`JOSHU_LANGFUSE_RELAY_URL` / `CONTROL_PLANE_URL`) with instance-agent Bearer
auth. **No Langfuse pk/sk on the box.** Requires `JOSHU_INSTANCE_ID` +
`INSTANCE_AGENT_TOKEN`. Enable via `JOSHU_HERMES_PLUGIN_NAMES=joshu-langfuse-relay`
(and leave stock `observability/langfuse` disabled).
