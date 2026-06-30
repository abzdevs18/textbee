# Gabay SMS - Android SMS Gateway

Gabay SMS is Gabay's customized self-hosted Android SMS gateway. It lets Gabay send and receive SMS through registered Android devices from a web dashboard or REST API, using `sms.gabay.online` as the public domain.

- **Technology stack**: React, Next.js, Node.js, NestJs, MongoDB, Android, Java
- **Link**: [https://sms.gabay.online](https://sms.gabay.online/)
- **Upstream base**: [vernu/textbee](https://github.com/vernu/textbee)


## Features

- Send & receive SMS messages via API & dashboard
- Use your own Android phone as an SMS gateway
- REST API for easy integration with apps & services
- Send Bulk SMS with CSV file
- Multi-device support for higher SMS throughput
- Secure API authentication with API keys
- Webhook support
- Self-hosting support for full control over your data




## Getting Started

1. Go to [sms.gabay.online](https://sms.gabay.online) and register or login with your account
2. Install the Gabay SMS app on your Android phone from [sms.gabay.online/download](https://sms.gabay.online/download)
3. Open the app and grant the permissions for SMS
4. Go to [sms.gabay.online/dashboard](https://sms.gabay.online/dashboard) and click register device / generate API key
5. Scan the QR code with the app or enter the API key manually
6. You are ready to send SMS messages from the dashboard or from your application via the REST API

**Code Snippet**: Few lines of code showing how to send an SMS message via the REST API

```javascript
const API_KEY = 'YOUR_API_KEY';
const DEVICE_ID = 'YOUR_DEVICE_ID';

await axios.post(`https://sms.gabay.online/api/v1/gateway/devices/${DEVICE_ID}/send-sms`, {
  recipients: [ '+251912345678' ],
  message: 'Hello World!',
}, {
  headers: {
    'x-api-key': API_KEY,
  },
});

```

**Code Snippet**: Curl command to send an SMS message via the REST API

```bash
curl -X POST "https://sms.gabay.online/api/v1/gateway/devices/YOUR_DEVICE_ID/send-sms" \
  -H 'x-api-key: YOUR_API_KEY' \
  -H 'Content-Type: application/json' \
  -d '{
    "recipients": [ "+251912345678" ],
    "message": "Hello World!"
  }'
```

### Receiving SMS Messages

To receive SMS messages, you can enable the feature from the mobile app. You can then fetch the received SMS messages via the REST API or view them in the dashboard. (Webhook notifications are coming soon)

**Code Snippet**: Few lines of code showing how to fetch received SMS messages via the REST API

```javascript
const API_KEY = 'YOUR_API_KEY';
const DEVICE_ID = 'YOUR_DEVICE_ID';

await axios.get(`https://sms.gabay.online/api/v1/gateway/devices/${DEVICE_ID}/get-received-sms`, {
  headers: {
    'x-api-key': API_KEY,
  },
});

```

**Code Snippet**: Curl command to fetch received SMS messages

```bash
curl -X GET "https://sms.gabay.online/api/v1/gateway/devices/YOUR_DEVICE_ID/get-received-sms"\
  -H "x-api-key: YOUR_API_KEY"
```

## Self-Hosting

### Setting Up Database

1. **Install MongoDB on Your Server**: Follow the official MongoDB installation guide for your operating system.
2. **Using MongoDB Atlas**: Alternatively, you can create a free database on MongoDB Atlas. Sign up at [MongoDB Atlas](https://www.mongodb.com/cloud/atlas) and follow the instructions to set up your database.

### Firebase Setup

1. Create a Firebase project.
2. Enable Firebase Cloud Messaging (FCM) in your Firebase project.
3. Obtain the Firebase credentials for backend use and the Android app.

### Building the Android App

1. Clone the repository and navigate to the Android project directory.
2. Update the `google-services.json` file with your Firebase project configuration.
3. Place the Firebase `google-services.json` files under the matching `android/app/src/{dev,prod}` source set.
4. Build the app using Android Studio or the command line:
   ```bash
   ./gradlew assembleRelease
   ```

### Building the Web

1. Navigate to the `web` directory.
2. Copy the `.env.example` file to `.env`:
   ```bash
   cp .env.example .env
   ```
3. Update the `.env` file with your own credentials.
4. Install dependencies:
   ```bash
   pnpm install
   ```
5. Build the web application:
   ```bash
   pnpm build
   ```

### Building the API

1. Navigate to the `api` directory.
2. Copy the `.env.example` file to `.env`:
   ```bash
   cp .env.example .env
   ```
3. Update the `.env` file with your own credentials.
4. Install dependencies:
   ```bash
   pnpm install
   ```
5. Build the API:
   ```bash
   pnpm build
   ```

### Hosting on a VPS

1. Install `pnpm`, `pm2`, and `Caddy` on your VPS.
2. Use `pm2` to manage your Node.js processes:
   ```bash
   pm2 start dist/main.js --name gabay-sms-api
   ```
3. Configure `Caddy` to serve the API under `/api/*` and the dashboard for everything else. Example Caddyfile:
   ```
   sms.gabay.online {
       reverse_proxy /api/* localhost:3001
       reverse_proxy /* localhost:3000
   }
   ```
4. Ensure your domain points to your VPS and Caddy is configured properly.

### Dockerized env
#### Requirements:   
- Docker installed
1. After setting up Firebase, update your `.env` in `web` && `api` folder.
   ```bash
   cd web && cp .env.example .env \
   && cd ../api && cp .env.example .env
   ```
2. Navigate to root folder and execute docker-compose.yml file.    
   This will spin up `web` and `api` containers alongside MongoDB, Redis, and Mongo Express. The `gabay_sms` database will be automatically created.
   ```bash
   docker compose up -d
   ```
   To stop the containers simply type
   ```bash
   docker compose down
   ```   

## Upstream attribution

This Gabay SMS fork is based on the open-source [TextBee](https://github.com/vernu/textbee) project. Keep the upstream license intact when syncing or rebasing.

## Bug Reporting and Feature Requests

Please report Gabay SMS bugs or feature requests through the Gabay engineering/support channel.

Please note that if you discover any vulnerability or security issue, we kindly request that you refrain from creating a public issue. Instead, send an email detailing the vulnerability to support@gabay.online.

## For support, feedback, and questions
Feel free to reach out at support@gabay.online.
