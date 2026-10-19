#!/usr/bin/env python3
"""Bundle the app into one self-contained runway.html (no build tools needed).

    python3 build-single.py            -> runway.html

Inlines styles.css, vendor/leaflet.css, vendor/leaflet.js, icons.js, zips.js,
model.js, app.js and icon.svg. Fonts still come from Google Fonts; without
internet the page falls back to the system sans-serif.
"""
import base64
import pathlib
import re

WEB = pathlib.Path(__file__).resolve().parent


def read(name: str) -> str:
    return (WEB / name).read_text(encoding="utf-8")


def safe_script(js: str) -> str:
    # Keep "</script>" inside strings from closing the tag early.
    return js.replace("</script", "<\\/script")


html = read("index.html")

css = read("vendor/leaflet.css") + "\n" + read("styles.css")
html = html.replace('<link rel="stylesheet" href="vendor/leaflet.css">\n', "")
html = html.replace('<link rel="stylesheet" href="styles.css">', f"<style>\n{css}\n</style>")

icon_uri = "data:image/svg+xml;base64," + base64.b64encode((WEB / "icon.svg").read_bytes()).decode()
html = html.replace('href="icon.svg"', f'href="{icon_uri}"')

for src in ["vendor/leaflet.js", "icons.js", "zips.js", "model.js", "app.js"]:
    tag = f'<script src="{src}"></script>'
    assert tag in html, f"missing {tag}"
    html = html.replace(tag, f"<script>\n{safe_script(read(src))}\n</script>")

assert not re.search(r'<script src="(?!https)', html), "a local script was not inlined"
out = WEB / "runway.html"
out.write_text(html, encoding="utf-8")
print(f"wrote {out} ({out.stat().st_size / 1e6:.1f} MB)")
