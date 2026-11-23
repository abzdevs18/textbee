package com.vernu.sms.remotescreen

import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import com.vernu.sms.R
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Screen-capture permission for Android 7–10, where accessibility screenshots
 * don't exist. Android shows its "Start now" prompt; on Android 9 and older,
 * ticking "Don't show again" once makes every later request silent.
 */
object RemoteScreenProjection {
    private const val TAG = "RemoteScreenProjection"
    /** Long enough for an auto-granted ("Don't show again") request to come back. */
    private const val SILENT_GRANT_MS = 2_500L
    private const val CONSENT_WAIT_MS = 120_000L

    @Volatile
    private var pending: CompletableDeferred<Pair<Int, Intent?>>? = null

    fun deliver(resultCode: Int, data: Intent?) {
        pending?.complete(resultCode to data)
    }

    /**
     * Returns a projection, or null if the phone's user declined / nobody
     * answered. [onPromptShown] fires when Android is visibly asking.
     */
    suspend fun obtain(context: Context, onPromptShown: () -> Unit): MediaProjection? {
        val deferred = CompletableDeferred<Pair<Int, Intent?>>()
        pending = deferred
        val needsForeground = Build.VERSION.SDK_INT == Build.VERSION_CODES.Q
        try {
            if (needsForeground && !ProjectionForegroundService.start(context)) {
                Log.w(TAG, "Could not start the media-projection foreground service")
                return null
            }
            context.startActivity(
                Intent(context, ProjectionPermissionActivity::class.java).addFlags(
                    Intent.FLAG_ACTIVITY_NEW_TASK or
                        Intent.FLAG_ACTIVITY_NO_ANIMATION or
                        Intent.FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS
                )
            )
            val result = withTimeoutOrNull(SILENT_GRANT_MS) { deferred.await() }
                ?: run {
                    onPromptShown()
                    withTimeoutOrNull(CONSENT_WAIT_MS) { deferred.await() }
                }
            if (result == null || result.first != Activity.RESULT_OK || result.second == null) {
                if (needsForeground) ProjectionForegroundService.stop(context)
                return null
            }
            val manager = context.getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
            return manager.getMediaProjection(result.first, result.second!!)
        } catch (e: Exception) {
            Log.w(TAG, "Screen capture permission failed: ${e.message}")
            if (needsForeground) ProjectionForegroundService.stop(context)
            return null
        } finally {
            if (pending === deferred) pending = null
        }
    }

    fun release(context: Context) {
        if (Build.VERSION.SDK_INT == Build.VERSION_CODES.Q) ProjectionForegroundService.stop(context)
    }
}

/** Invisible trampoline that asks Android for screen-capture permission. */
class ProjectionPermissionActivity : Activity() {
    private var answered = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (savedInstanceState != null) return
        val manager = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        try {
            @Suppress("DEPRECATION")
            startActivityForResult(manager.createScreenCaptureIntent(), REQUEST)
        } catch (e: Exception) {
            answer(RESULT_CANCELED, null)
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        @Suppress("DEPRECATION")
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQUEST) answer(resultCode, data)
    }

    override fun onDestroy() {
        if (!answered && isFinishing) RemoteScreenProjection.deliver(RESULT_CANCELED, null)
        super.onDestroy()
    }

    private fun answer(resultCode: Int, data: Intent?) {
        answered = true
        RemoteScreenProjection.deliver(resultCode, data)
        finish()
        @Suppress("DEPRECATION")
        overridePendingTransition(0, 0)
    }

    private companion object {
        const val REQUEST = 7351
    }
}

/**
 * Android 10 only: MediaProjection requires a running foreground service of
 * type mediaProjection. Lives just for the viewing session.
 */
class ProjectionForegroundService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val manager = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL, "Remote screen", NotificationManager.IMPORTANCE_MIN)
            )
        }
        val notification: Notification = NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("Gabay SMS")
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setOngoing(true)
            .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
        } else {
            startForeground(ID, notification)
        }
        running = true
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        running = false
        super.onDestroy()
    }

    companion object {
        private const val CHANNEL = "remote_screen_capture_v1"
        private const val ID = 7352
        @Volatile private var running = false

        /** Starts it and waits until it is in the foreground. */
        suspend fun start(context: Context): Boolean {
            if (running) return true
            val intent = Intent(context, ProjectionForegroundService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent)
            else context.startService(intent)
            repeat(30) {
                if (running) return true
                delay(100)
            }
            return running
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, ProjectionForegroundService::class.java))
        }
    }
}
