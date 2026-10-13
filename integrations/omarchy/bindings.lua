-- Append to ~/.config/hypr/bindings.lua (Omarchy, Lua config).
-- SUPER+SHIFT+A is an Omarchy default (a web app), so Aurora uses ALT. Check for clashes with:
--   omarchy menu keybindings --print
o.bind("SUPER + ALT + A", "Aurora", "omarchy-launch-webapp http://127.0.0.1:4317")
o.bind("SUPER + ALT + SHIFT + A", "Aurora in the terminal", "omarchy-launch-tui --app-id=org.omarchy.aurora node " .. os.getenv("HOME") .. "/Projects/social-reader/cli/aurora.ts")
-- Pick a post in Walker and open it (marks it read in Aurora). Add --saved or --later for those lists.
o.bind("SUPER + ALT + P", "Aurora: pick a post", "node " .. os.getenv("HOME") .. "/Projects/social-reader/cli/aurora.ts pick")
-- Aurora desktop app: Quick look (top posts, alerts, Ask) over whatever you are doing. Electron's own
-- shortcut (Ctrl+Alt+Space) often cannot register under Wayland, so bind it here. Use the AppImage
-- path, or "xdg-open aurora://quick" with an installed build, if `aurora` is not on your PATH.
-- o.bind("SUPER + ALT + Q", "Aurora quick look", "aurora --quick")
-- Morning read: open today's Front page, or lean back with Ambient on a second monitor.
-- o.bind("SUPER + ALT + F", "Aurora front page", "omarchy-launch-webapp 'http://127.0.0.1:4317/?front=1'")
-- o.bind("SUPER + ALT + M", "Aurora ambient", "omarchy-launch-webapp 'http://127.0.0.1:4317/?ambient=1'")
