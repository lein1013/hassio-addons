# Home Notes XR

Post-its und kurze Video-Anleitungen mit der Meta Quest dort in der Wohnung
platzieren, wo sie gebraucht werden. Am PC verwaltest du alles in der
Home-Assistant-Seitenleiste unter **Home Notes**.

## Erste Schritte

1. In der HA-Seitenleiste **Home Notes** öffnen: Übersicht aller Post-its und Videos.
2. Im Quest-Browser `https://<HA-IP>:8443/` öffnen (z. B. `https://10.0.0.100:8443/`).
   Die Zertifikatswarnung einmal mit „Erweitert → Weiter“ bestätigen.
3. Einmal **Kamera & Mikrofon freigeben** tippen, dann **AR starten**.

## Steuerung im Headset

**Menü am linken Controller** (mit dem rechten Strahl zeigen, Trigger drücken):
＋ Notiz · 🎙 Diktat · ● Video · 🗺 Karte (oben rechts → am rechten Controller → aus) · ▦ Scan-Anzeige

**Auf eine Notiz zeigen** – die Aktionsleiste erscheint:
✓ abhaken · 🎙 Text sprechen (Trigger beendet) · ✥ verschieben (Trigger setzt ab) · 🎨 Farbe · 🗑 löschen (zweimal)

**Auf ein Video zeigen:** ▶ abspielen · 🎙 Titel · ✥ verschieben · 🗑 löschen

**Trigger ins Leere** platziert das Nächste aus der Warteschlange (Vorschau am Strahl,
Abstand mit dem rechten Stick).

Abkürzungen: A halten = diktieren · B 2× = löschen · Grip = greifen · X = Video · Y = Farbe ·
linken Stick drücken = Karte.

**Ohne Raum-Scan (Standard):** keine Raumeinrichtung, keine Begrenzung nötig.
**Mit Raum-Scan** (unter „Erweitert“): Notizen haften an Wänden und Möbeln, Wände erscheinen auf der Karte.

## Video-Anleitungen

Auf der Startseite „Kamera & Mikrofon freigeben“ tippen und in der Liste die Kamera wählen,
deren Vorschau dein Zimmer zeigt. Die „virtuelle Kamera“ der Quest zeigt in Mixed Reality nur Schwarz.

## Hauskarte

Der erste Ankerpunkt ist die Heimat der Karte. Während du im Headset herumgehst, werden
deine Wege (10-cm-Raster) gespeichert, mit Raum-Scan auch Wände. Notizen erscheinen als
Punkte, Videos als Dreiecke. In der Übersicht gibt es die Draufsicht; ein Klick auf einen
Punkt springt zur Karte der Notiz.

## Warteschlange

Am PC angelegte Notizen und „Neu platzieren“ landen in einer Warteschlange.
Im Headset zeigt die Vorschau die nächste Notiz – ein Trigger setzt sie.

## Ankerpunkte

Der Quest-Browser speichert höchstens 8 dauerhafte Anker pro Website. Home Notes
hängt Notizen deshalb an Ankerpunkte; ein neuer entsteht nur, wenn im Umkreis
von 4 m noch keiner existiert. Nicht mehr genutzte Ankerpunkte werden automatisch
freigegeben.

## Optionen

- `certfile` / `keyfile`: Zertifikat im `/ssl`-Ordner (Standard: Duck-DNS/Let's Encrypt).
  Fehlt es, wird ein selbstsigniertes erzeugt.
- `stt_entity`: Spracherkennung, z. B. `stt.home_assistant_cloud`. Leer = automatisch
  (Home Assistant Cloud bevorzugt).
- `language`: Sprache für die Spracherkennung (Standard `de`).

## Daten

- Notizen: `/data/homenotes.json` (im HA-Backup enthalten)
- Videos: `/media/homenotes/` (auch im HA-Medienbrowser sichtbar)

## Grenzen

- Port 8443 hat keine Anmeldung – nur im Heimnetz nutzen, nicht freigeben.
- Mikrofon am PC funktioniert nur über HTTPS (Port 8443), nicht über die Seitenleiste per HTTP.
