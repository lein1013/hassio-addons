# Changelog

## 0.3.1

- Bewegungsbereich „Ganze Wohnung“ (WebXR-Referenzraum `unbounded`) als Standard: Der
  Quest-Browser blendet keine Begrenzung ein, man kann sich frei durch die Wohnung bewegen.
  Anker werden dabei im `local`-Raum angelegt. Auswahl unter „Erweitert“ (unbounded / local / local-floor).

## 0.3.0

- Keine Raum-/Begrenzungsabfrage mehr: Standard-Referenzraum `local` statt `local-floor`
  (Boden-Referenz und Raum-Scan optional unter „Erweitert“).
- Video-Anleitungen: Kamera-Auswahl mit Live-Vorschau – die virtuelle Kamera der Quest liefert
  in Mixed Reality nur Schwarz; die Passthrough-Kamera wird bevorzugt.
- Aktionsleiste an jeder Notiz: ✓ abhaken, 🎙 sprechen, ✥ verschieben, 🎨 Farbe, 🗑 löschen;
  bei Videos ▶, 🎙, ✥, 🗑. Bedienbar auch mit Handtracking.
- Menü am linken Controller: ＋ Notiz, 🎙 Diktat, ● Video, 🗺 Karte, ▦ Scan-Anzeige.
- Trigger ins Leere legt keine leeren Notizen mehr an – nur noch, was in der Warteschlange steht.
- Hauskarte: gelaufene Wege (und mit Raum-Scan Wände) werden relativ zum Heimat-Ankerpunkt
  gespeichert; Minimap oben rechts oder am rechten Controller, Draufsicht in der Übersicht.
- Verlorene Ankerpunkte werden erkannt, ihre Notizen landen wieder in der Warteschlange.

## 0.2.0

- Umbenannt in **Home Notes XR** (neuer Slug `homenotes_xr`, Daten starten leer).
- Spracheingabe: A halten zum Diktieren, Erkennung über die Spracherkennung von Home Assistant.
- Notizen verschieben (Grip), löschen (B zweimal), abhaken (Trigger), Farbe ändern (Y).
- Funktioniert ohne Raum-Scan: freie Platzierung mit einstellbarem Abstand; Raum-Scan optional.
- Video-Anleitungen: mit X aufnehmen, mit Trigger platzieren, im Raum abspielen.
- Ankerpunkte statt eines Ankers pro Notiz – umgeht das 8-Anker-Limit, räumt verwaiste Anker auf.
- Desktop-Übersicht in der HA-Seitenleiste: Post-its und Videos filtern, bearbeiten,
  abhaken, löschen, neu platzieren, neue Notizen anlegen.

## 0.1.1 (HausAnker XR)

- Ingress-Zugriff aus dem gesamten Home-Assistant-Netz erlauben.

## 0.1.0 (HausAnker XR)

- Erster Minimaltest: Post-its setzen/löschen, persistente Anker, Ebenen- und Mesh-Anzeige.
