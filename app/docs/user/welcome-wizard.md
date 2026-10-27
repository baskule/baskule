# Welcome wizard

T3 Code shows a setup flow when you open a new installation. Existing
workspaces skip this flow.

The hosted app at app.t3.codes does not open setup. With no computer connected,
it asks you to sign in to T3 Connect, then to run `npx t3 connect` on your
computer. From home, it adds compatible computers linked to your account and
opens the app.

Close setup to go straight to the app. You can connect
computers and agents later from Settings, or open `/welcome` to run setup again.
Direct links, such as Settings, open normally before setup is done.

## Connect your computers

Select one or more computers to set up. If you opened T3 Code directly from a
server or the desktop app, that computer is already connected and selected.
It is identified by its name, which may differ from the device running your
browser.

You can add more computers before continuing:

- **T3 Connect** connects computers that are signed in to your account.
  [Install the CLI](./install.md#command-line) and run `t3 connect` on each
  computer you want to add, then start T3 Code or run `t3 serve` so the
  computer stays available.
- **Add a computer** connects directly to a server on your network or tailnet.
  Start the server with `t3 serve`, then run `t3 pair --tailscale` and paste
  the pairing link. You can also run `t3 serve --host <address>` and use
  `t3 pair` when the server is already reachable on your network.

A computer marked **Client not supported** runs a T3 Code version that cannot
talk to this app. The message under its name says which side to update.

Saved computers and computers discovered through T3 Connect are selected by
default. Uncheck any you do not want to set up; this does not disconnect them.
Continue when your selected computers are connected. Setup checks
OpenCode across the selected computers.

If T3 Code cannot confirm the workspace during startup, the setup flow shows
**Still connecting** instead of opening the app. Select **Reload** to try again.

If T3 Code cannot read your saved settings, it shows **Could not read settings**.
Select **Retry** after storage becomes available. Setup does not replace
unreadable settings with defaults.

## Check OpenCode

Setup checks the selected computers for OpenCode 2. Configure and enable OpenCode instances
in **Settings → Providers**. Each instance can use a local runtime or an external OpenCode 2
server, with its own environment and credentials. Models from every vendor run through OpenCode.

Add projects from the app after setup. Setup does not import history from other agent harnesses.
