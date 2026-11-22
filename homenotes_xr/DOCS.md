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

| Eingabe | Wirkung |
|---|---|
| Trigger / Pinch | Nächste Notiz setzen · auf Notiz: abhaken · auf Video: Play/Pause |
| Grip halten | Notiz greifen und verschieben (rechter Stick: näher/weiter) |
| Rechter Stick | Abstand der Vorschau ohne Raum-Scan |
| A halten | Diktieren – auf eine Notiz zeigen ersetzt deren Text, sonst Text für die nächste Notiz |
| B zweimal | Notiz oder Video löschen |
| X | Video-Anleitung aufnehmen / stoppen, danach mit Trigger platzieren |
| Y | Farbe wechseln (auf Notiz: deren Farbe) |
| Linken Stick drücken | Raum-Scan-Anzeige ein/aus |

**Ohne Raum-Scan (Standard):** Notizen schweben dort, wohin der Controller zeigt
(Abstand mit dem Stick). Dafür muss die Wohnung nicht eingerichtet sein.
**Mit Raum-Scan:** Notizen haften an erkannten Wänden und Möbeln.

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
