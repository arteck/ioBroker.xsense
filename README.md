![Logo](admin/xsense.png)
# ioBroker.xsense
=================

[![NPM](https://nodei.co/npm/iobroker.xsense.png?downloads=true)](https://nodei.co/npm/iobroker.xsense/)

[![NPM version](http://img.shields.io/npm/v/iobroker.xsense.svg)](https://www.npmjs.com/package/iobroker.xsense)
[![Downloads](https://img.shields.io/npm/dm/iobroker.xsense.svg)](https://www.npmjs.com/package/iobroker.xsense)
![GitHub last commit](https://img.shields.io/github/last-commit/arteck/ioBroker.xsense)
![GitHub issues](https://img.shields.io/github/issues/arteck/ioBroker.xsense)[![License](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/arteck/ioBroker.xsense/blob/master/LICENSE)

</br>
**Version:** </br>

![Number of Installations](http://iobroker.live/badges/xsense-installed.svg)
![Beta](https://img.shields.io/npm/v/iobroker.xsense.svg?color=red&label=beta)
![Stable](https://iobroker.live/badges/xsense-stable.svg)


xsense Adapter for ioBroker
------------------------------------------------------------------------------

Dieser ioBroker-Adapter ermöglicht die Integration von XSense-Geräten in das ioBroker Smart-Home-System. 
Er wurde entwickelt, um Daten von XSense-Rauchmeldern, CO-Meldern und weiteren kompatiblen Geräten zu empfangen und für Automatisierungen und Überwachungen im ioBroker bereitzustellen.
Der Adapter basiert auf der Kommunikation mit dem XSense-Cloud-Server und bietet eine einfache Möglichkeit, XSense-Geräte in bestehende ioBroker-Setups zu integrieren.

🔧 Unterstützte Geräte
- Rauchmelder
- Kohlenmonoxidmelder
- Hitzemelder
- Wassermelder
- Hygrometer
- Basisstationen (sofern unterstützt)


⚠️ Voraussetzungen
- Ein XSense-Konto mit registrierten Geräten
- Internetverbindung für Cloud-Kommunikation
- Python = 3.13 erforderlich (für die X-Sense-Kommunikation via Python-Wrapper).

📦 Vorbereitung

Da XSense keine parallele Anmeldung in App und Drittanbieter-Software erlaubt, empfiehlt sich folgendes Vorgehen:

- Zweitkonto erstellen: Erstelle in der XSense-App ein zweites Konto.
- Geräte teilen: Teile die gewünschten Geräte vom Hauptkonto mit dem neuen Konto.
- Zugangsdaten im Adapter eintragen: Verwende das Zweitkonto für die Verbindung im ioBroker.

------------------------------------------------------------------------------

## 🚀 Installation

### 💻 Windows

1. **Python installieren**
   - Download: [https://www.python.org/downloads/windows/](https://www.python.org/downloads/windows/)
   - Während der Installation **"Add Python to PATH" aktivieren**
   - Danach prüfen:
     ```powershell
     python --version
     pip --version
     ```
     
### 🐧 Linux
   ```sudo apt update
        sudo apt install python3 python3-pip -y
   ```

### 🐳 Docker


   ```
      apt update && apt install -y python3 python3-pip
   ```
------------------------------------------------------------------------------


Es ist notwendig die installierte Python Version anzugeben
```
      python --version
 ```

<img width="1029" height="438" alt="grafik" src="https://github.com/user-attachments/assets/86e4fd1c-1d4e-4234-a2ad-48b8dd9f418e" />

    

------------------------------------------------------------------------------

## Changelog
### 0.0.1 (2025-07-27)
* (arteck) initial release



## 📜 Lizenz

MIT License – siehe [LICENSE](https://github.com/arteck/ioBroker.xsense/blob/main/LICENSE) für Details.
