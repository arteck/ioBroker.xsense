# ioBroker XSense Adapter

## 🧭 Overview

This ioBroker adapter enables integration of **XSense devices** into the ioBroker smart home system. It is designed to receive data from XSense smoke detectors, CO detectors, and other compatible devices, making them available for automation and monitoring within ioBroker.

The adapter communicates with the XSense cloud server, providing a simple way to connect XSense devices to your existing ioBroker setup.

---

## 🔧 Supported Devices

- Smoke detectors  
- Carbon monoxide detectors  
- Heat detectors  
- Water leak detectors  
- Hygrometers  
- Base stations (if supported)

---

## 📦 Requirements

- An XSense account with registered devices  
- Internet connection for cloud communication

---


## 🧪 Preparation

Since XSense does not allow simultaneous login from the app and third-party software, the following setup is recommended:

1. **Create a secondary account**: Register a second account in the XSense app.  
2. **Share devices**: Share the desired devices from your main account with the new account.  
3. **Use secondary account in adapter**: Use the secondary account credentials in the ioBroker adapter.

---

## 📜 License

MIT License – see [LICENSE](https://github.com/arteck/ioBroker.xsense/blob/main/LICENSE) for details.
