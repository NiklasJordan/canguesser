# CANguesser

A quiz built on EUMETSAT's [Climate Anomalies and Normals (CAN) service](https://can.eumetsat.int). Players guess the place and year of 20 climate events from 2007 to 2025, such as droughts, floods, sunshine records and sea ice extremes. The top ten scores are shown on the leaderboard.

- **Noob**: an anomaly map of the event, with the region outlined. Three options for the place and three for the year.
- **Expert**: the same options, but only a 12-month chart of actual values against the 1991–2020 normal.

Each round gives 500 points for the right place and 500 for the right year. A wrong answer scores nothing. After each answer, an info box explains the event and links to Wikipedia and one authoritative source.

## Run it

```bash
docker compose up -d --build
# open http://localhost:3099
```

Scores live in `/data/scores.db` inside the container, on the named volume `scores`. They survive restarts and rebuilds. To back up:

```bash
docker compose cp quiz:/data/scores.db ./scores-backup.db
```

On first start the server builds the 20 events from the CAN Zarr stores in the background (see Data below)

## Data

The server reads the data straight from CAN's analysis-ready Zarr stores, found through the STAC catalogue (`catalog.json` → variable collection → `NORMALS` / `ANOMALIES` → `*_hp<nside>_{maps,ts}.zarr`). The stores are streamed.

- **Region series** (Expert chart, year ranking): the time-optimised store (`_ts`). Every HEALPix cell whose centre falls inside the country (Natural Earth 50m) or latitude band is averaged per month.
- **Normals**: the same cells in the normals store, giving 12 calendar months for 1991–2020.
- **Anomaly map** (Noob): the map-optimised store (`_maps`). The event months are averaged and resampled from HEALPix to a lon/lat grid over the event box.

Each event is written as its own small Zarr v3 store (11–31 KB), `<k>.zarr`, with values in display units:

| Array | Dimensions | Content |
|---|---|---|
| `anomaly_map` | `lat, lon` | mean anomaly over the event months, on a lon/lat grid over the event box |
| `region_anomaly` | `time` | region-mean anomaly for every month of the CAN record |
| `region_normal` | `month` | region-mean 1991–2020 normal for each calendar month |
| `time`, `lat`, `lon`, `month` | | coordinates (`time` is CF: days since the first month, one value per month start) |

The root attributes record the variable, units, event months, region, HEALPix resolution and ordering, the CAN source stores and the build time. The root `zarr.json` also inlines the metadata of every array (consolidated metadata), so readers can open a store over plain HTTP, for example `xarray.open_zarr("http://localhost:3099/events/SOO23.zarr")`.

The browser reads the store for each round on the fly with [zarrita](https://github.com/manzt/zarrita.js), served from `node_modules` and loaded through an import map, so the page needs no build step. The yearly values and the 12-month chart are derived in the browser by `public/event-data.js`. The server runs the same derivation on every event before publishing its store, so an event whose period is missing from the record is never published.

If CAN can't be reached, or one event fails, the server serves the bundled snapshot (October 2026) in `public/events/` for those events.

Country borders are Natural Earth 50m, from world-atlas. EUMETSAT CAN service, with climate data records from the CM SAF (SARAH-3), H SAF and OSI SAF.
