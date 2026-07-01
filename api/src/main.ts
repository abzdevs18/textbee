import 'dotenv/config'
import * as crypto from 'crypto'
import { VersioningType, Logger } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'
import * as firebase from 'firebase-admin'
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger'
import * as express from 'express'
import { NestExpressApplication } from '@nestjs/platform-express'

// Ensure crypto is available globally for @nestjs/schedule
if (typeof globalThis.crypto === 'undefined') {
  globalThis.crypto = crypto as any
}

// Global error handlers to prevent server crashes
const logger = new Logger('GlobalErrorHandler')

process.on('uncaughtException', (error: Error) => {
  logger.error('Uncaught Exception:', error.stack || error.message)
  // Don't exit the process for uncaught exceptions in production
  // process.exit(1)
})

process.on('unhandledRejection', (reason: any, promise: Promise<any>) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason)
})

type FirebaseServiceAccountConfig = {
  projectId?: string
  privateKeyId?: string
  privateKey?: string
  clientEmail?: string
  clientId?: string
  clientC509CertUrl?: string
}

function normalizePrivateKey(privateKey?: string) {
  return privateKey?.replace(/\\n/g, '\n')
}

function getFirebaseConfigFromJson(): FirebaseServiceAccountConfig | null {
  const rawJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim()
  if (!rawJson) return null

  try {
    const parsed = JSON.parse(rawJson)
    return {
      projectId: parsed.project_id || parsed.projectId,
      privateKeyId: parsed.private_key_id || parsed.privateKeyId,
      privateKey: normalizePrivateKey(parsed.private_key || parsed.privateKey),
      clientEmail: parsed.client_email || parsed.clientEmail,
      clientId: parsed.client_id || parsed.clientId,
      clientC509CertUrl:
        parsed.client_x509_cert_url || parsed.clientC509CertUrl,
    }
  } catch (error) {
    logger.error(
      'FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON; falling back to individual FIREBASE_* variables.',
      (error as Error).message,
    )
    return null
  }
}

function getFirebaseConfigFromEnv(): FirebaseServiceAccountConfig {
  return {
    projectId: process.env.FIREBASE_PROJECT_ID,
    privateKeyId: process.env.FIREBASE_PRIVATE_KEY_ID,
    privateKey: normalizePrivateKey(process.env.FIREBASE_PRIVATE_KEY),
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    clientId: process.env.FIREBASE_CLIENT_ID,
    clientC509CertUrl: process.env.FIREBASE_CLIENT_C509_CERT_URL,
  }
}

function hasRequiredFirebaseFields(config: FirebaseServiceAccountConfig) {
  return Boolean(config.projectId && config.privateKey && config.clientEmail)
}

function getFirebaseConfig(): FirebaseServiceAccountConfig {
  const jsonConfig = getFirebaseConfigFromJson()
  if (jsonConfig && hasRequiredFirebaseFields(jsonConfig)) {
    return jsonConfig
  }

  if (jsonConfig) {
    logger.warn(
      'FIREBASE_SERVICE_ACCOUNT_JSON is present but does not contain service-account private_key/client_email. Android google-services.json cannot be used for server push notifications.',
    )
  }

  return getFirebaseConfigFromEnv()
}

function initializeFirebaseAdmin() {
  const firebaseConfig = getFirebaseConfig()

  if (hasRequiredFirebaseFields(firebaseConfig)) {
    const serviceAccountConfig = {
      type: 'service_account',
      projectId: firebaseConfig.projectId,
      privateKeyId: firebaseConfig.privateKeyId,
      privateKey: firebaseConfig.privateKey,
      clientEmail: firebaseConfig.clientEmail,
      clientId: firebaseConfig.clientId,
      authUri: 'https://accounts.google.com/o/oauth2/auth',
      tokenUri: 'https://oauth2.googleapis.com/token',
      authProviderX509CertUrl: 'https://www.googleapis.com/oauth2/v1/certs',
      clientC509CertUrl: firebaseConfig.clientC509CertUrl,
    }

    firebase.initializeApp({
      credential: firebase.credential.cert(serviceAccountConfig),
    })
    logger.log(`Firebase Admin initialized for project ${firebaseConfig.projectId}`)
  } else {
    logger.warn(
      'Firebase service account is not configured; push notifications are disabled.',
    )
  }
}

async function bootstrap() {
  initializeFirebaseAdmin()

  const app: NestExpressApplication = await NestFactory.create(AppModule)
  const PORT = process.env.PORT || 3001

  app.setGlobalPrefix('api')
  app.enableVersioning({
    defaultVersion: '1',
    type: VersioningType.URI,
  })

  const config = new DocumentBuilder()
    .setTitle('Gabay SMS API Docs')
    .setDescription('Gabay SMS - Android SMS Gateway API Docs')
    .setVersion('1.0')
    .addBearerAuth()
    .addApiKey({
      type: 'apiKey',
      name: 'x-api-key',
      in: 'header',
    })
    .build()
  const document = SwaggerModule.createDocument(app, config)
  SwaggerModule.setup('', app, document, {
    swaggerOptions: {
      persistAuthorization: true,
    },
  })

  app.use(
    '/api/v1/billing/webhook/polar',
    express.raw({ type: 'application/json' }),
  )
  app.useBodyParser('json', { limit: '2mb' });
  app.enableCors()
  await app.listen(PORT)
}
bootstrap()
