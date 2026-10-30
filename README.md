# BB Plugins

A collection of plugins for [BB](https://getbb.app).

## Plugins

- `bb-sidebar`
- `bell`
- `mise`
- `pi`
- `plain-copy` (copying selected timeline text yields plain text instead of Markdown)
- `usagi` (connects to [bgwastu/usagi](https://github.com/bgwastu/usagi))
- `web-push` (real Web Push notifications for browsers and phones, with the tab closed)

## Install

Install a plugin from this repository:

```sh
bb plugin install git:https://github.com/bgwastu/bb-plugins.git@main --plugin bb-sidebar
```

Replace `bb-sidebar` with another plugin ID to install a different plugin.

## Update

```sh
bb plugin outdated
bb plugin update <plugin-id>
```
