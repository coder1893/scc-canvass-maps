# Surrey City Centre campaign map

A static dashboard for the Surrey City Centre provincial riding: polls shaded by the 2024 result, election-day voting places, how the 2024 votes came in, and, once you load your own exports, supporters identified, contact rates, a canvass priority per poll and every contacted household on a labelled street map.

**The page is password-protected.** The team's campaign data (Poll Summary and Interactions, with voter names, notes and canvassers removed) is in `data/campaign.enc.js`, encrypted with AES-256-GCM under a key derived from the team password (PBKDF2-SHA256, 600,000 iterations). Without the password the file can't be read, so copying the site or this repository yields nothing usable. Everything else is public: `data/public.js` is built from BC open data: Elections BC 2024 boundaries, voting areas, registered voter counts, results by voting place and the poll-to-voting-place assignment; the BC Digital Road Atlas; and BC Address Geocoder address points.

Open the page and enter the team password. The data is decrypted in your browser only; the page's Content-Security-Policy blocks every outbound connection, so nothing is sent anywhere. Closing the tab locks it again. You can also load newer exports (.xlsx) from your own device; they stay in that tab.

Libraries: [Leaflet](https://leafletjs.com) 1.9.4 and [SheetJS](https://sheetjs.com) 0.20.3, vendored in `vendor/`.
