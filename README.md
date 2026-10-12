# Surrey City Centre campaign map

A static dashboard for the Surrey City Centre provincial riding: polls shaded by the 2024 result, election-day voting places, how the 2024 votes came in, and, once you load your own exports, supporters identified, contact rates, a canvass priority per poll and every contacted household on a labelled street map.

**This repository holds public data only.** `data/public.js` is built from BC open data: Elections BC 2024 boundaries, voting areas, registered voter counts, results by voting place and the poll-to-voting-place assignment; the BC Digital Road Atlas; and BC Address Geocoder address points.

Campaign data never comes here. Open the page and load the Poll Summary and Interactions exports (.xlsx): they are read in your browser and are not uploaded. The page's Content-Security-Policy blocks every outbound connection, and closing the tab clears the files.

Libraries: [Leaflet](https://leafletjs.com) 1.9.4 and [SheetJS](https://sheetjs.com) 0.20.3, vendored in `vendor/`.
