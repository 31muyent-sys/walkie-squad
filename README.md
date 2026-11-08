# Walkie Squad

Turn two or more phones into push-to-talk walkie-talkies. Make a room, share the 4-letter code or invite link,
then hold the big button (or Space) to talk. No app, no account. Audio goes straight between the phones (WebRTC);
the free PeerJS public server only introduces them.

## Try it on this laptop

Double-click `run.bat`, then open http://127.0.0.1:8220 in two tabs. One makes a room, the other joins with the code.

## Use it on real phones

Phones only allow the microphone on HTTPS sites, so put the folder online for free:

- **GitHub Pages:** push this repo to GitHub, then Settings > Pages > deploy from the `main` branch.
- **Netlify:** drag this folder onto https://app.netlify.com/drop.

Then open the https link on both phones.

## Limits

- The room lives on the host's phone: if the host leaves, the room closes.
- Best for small squads (up to about 6); every phone connects to every other phone.
- Some strict school or work Wi-Fi blocks peer-to-peer calls.
