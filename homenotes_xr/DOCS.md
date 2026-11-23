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

**Menü am linken Controller** – mit dem rechten Strahl zeigen und Trigger drücken:
＋ Notiz · 🎙 Diktat · 🎬 Video · 📋 Übersicht · 🗺 Karte · 🎨 Farbe. X blendet das Menü aus und ein.

**🎬 Video-Anleitung:** ● Aufnahme starten → ■ Stopp & behalten oder ✕ Verwerfen → ▶ Ansehen ·
🎙 Titel sprechen · ↺ Neu aufnehmen · 🗑 Verwerfen → mit dem Trigger ins Leere platzieren.
Erkläre beim Filmen, was du tust: Daraus entstehen Titel und Transkript.

**Notizen:** antippen = Text sprechen (Trigger beendet). Aktionsleiste darunter:
✓ abhaken · 🎙 · ✥ verschieben · 🎨 Farbe · 🗑 löschen (zweimal).
**Videos:** Bild antippen = Play/Pause, Titelzeile antippen = Titel sprechen.

**📋 Übersicht:** Liste aller Einträge – ✓ abhaken, ➜ Zeigen (gelbe Linie zur Notiz),
📍 als Nächstes platzieren, 🗑 löschen. Mit Grip verschieben.

**🗺 Karte:** Kopfzeile 👁 folgt dem Blick · 📌 fix im Raum · ✋ am Controller · ✕ aus.
Mit Grip greifen und dorthin schieben, wo du sie haben willst – im Modus „folgt“ merkt sie sich die Stelle.

Abkürzungen: A halten = diktieren · B 2× = löschen · Grip = greifen · Y = Farbe ·
linken Stick drücken = Karte ein/aus. Rechter Stick = Abstand der Vorschau.

**Bewegungsbereich „Ganze Wohnung“ (Standard):** keine Begrenzung, frei durch alle Räume gehen.
**Grundriss erfassen (Standard an):** Der Tiefensensor tastet beim Herumgehen Wände ab – ohne Raum-Scan.

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
- `title_agent`: Konversationsagent für Video-Titel, z. B. `conversation.ollama_conversation`.
  Leer = automatisch, `aus` = nur erster Satz des Transkripts.

## Daten

- Notizen: `/data/homenotes.json` (im HA-Backup enthalten)
- Videos: `/media/homenotes/` (auch im HA-Medienbrowser sichtbar)

## Grenzen

- Port 8443 hat keine Anmeldung – nur im Heimnetz nutzen, nicht freigeben.
- Mikrofon am PC funktioniert nur über HTTPS (Port 8443), nicht über die Seitenleiste per HTTP.
