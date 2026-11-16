# PMU Bookings On Demand — iPhone app

The client app is the web app at `/m` (sign-in, bookings, chats, profit, billing).
This folder is the native iPhone "shell" around it (Capacitor 8): it opens
`server.url` from `capacitor.config.json`. Screen changes go live on the server
right away; only changes to the shell itself (icon, name, permissions, push
notifications) need a new App Store version.

Built in the cloud by `.github/workflows/ios-build.yml` (Apple requires Xcode 26+).
Signing and the upload to App Store Connect are added once the Apple Developer
account (N. MIZRAHI GROUP CY LTD) is approved.
