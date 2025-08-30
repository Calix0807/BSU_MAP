# app.py
from flask import Flask, render_template
import json, os

app = Flask(__name__)

def load_campus():
    path = os.path.join(app.static_folder, "data", "campus.json")
    with open(path, encoding="utf-8") as f:
        return json.load(f)

@app.route("/")
def index():
    return render_template("index.html")

@app.route("/building/<bid>")
def building(bid: str):
    data = load_campus()
    buildings = data.get("buildings", [])
    # Print the available IDs to the console for quick debugging
    print("Available buildings:", [b.get("id") for b in buildings])

    # Normalize: strip and compare exactly (case-sensitive)
    key = (bid or "").strip()
    bldg = next((b for b in buildings if (b.get("id") or "").strip() == key), None)

    # Rooms split into 'room' vs 'cr'
    all_rooms = [r for r in data.get("rooms", []) if (r.get("parent") or "").strip() == key]
    rooms = [r for r in all_rooms if r.get("type") == "room"]
    crs   = [r for r in all_rooms if r.get("type") == "cr"]
    schedules = data.get("schedules", {})

    return render_template("building.html",
                           building=bldg, rooms=rooms, crs=crs, schedules=schedules)

if __name__ == "__main__":
    app.run(debug=True, host="0.0.0.0")
