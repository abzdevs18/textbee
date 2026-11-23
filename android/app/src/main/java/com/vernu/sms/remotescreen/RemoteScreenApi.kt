package com.vernu.sms.remotescreen

import com.vernu.sms.AppConstants
import com.vernu.sms.LegacyTls
import com.vernu.sms.dtos.RemoteScreenFrameRequest
import com.vernu.sms.dtos.RemoteScreenFrameResponse
import com.vernu.sms.dtos.RemoteScreenStatusRequest
import retrofit2.Response
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.Header
import retrofit2.http.POST
import retrofit2.http.Path
import retrofit2.http.Query
import java.util.concurrent.TimeUnit

interface RemoteScreenApiService {
    @POST("gateway/devices/{deviceId}/remote-screen/frame")
    suspend fun uploadFrame(
        @Path("deviceId") deviceId: String,
        @Header("x-api-key") apiKey: String,
        @Body body: RemoteScreenFrameRequest
    ): Response<RemoteScreenFrameResponse>

    @POST("gateway/devices/{deviceId}/remote-screen/status")
    suspend fun reportStatus(
        @Path("deviceId") deviceId: String,
        @Header("x-api-key") apiKey: String,
        @Body body: RemoteScreenStatusRequest
    ): Response<Any>

    /** Long-poll: the server answers as soon as the viewer taps (or after ~8s). */
    @GET("gateway/devices/{deviceId}/remote-screen/commands")
    suspend fun pollCommands(
        @Path("deviceId") deviceId: String,
        @Header("x-api-key") apiKey: String,
        @Query("sessionId") sessionId: String,
        @Query("wait") wait: Int = 1
    ): Response<RemoteScreenFrameResponse>

    // Security camera: same protocol, its own session on the server.

    @POST("gateway/devices/{deviceId}/remote-camera/frame")
    suspend fun uploadCameraFrame(
        @Path("deviceId") deviceId: String,
        @Header("x-api-key") apiKey: String,
        @Body body: RemoteScreenFrameRequest
    ): Response<RemoteScreenFrameResponse>

    @POST("gateway/devices/{deviceId}/remote-camera/status")
    suspend fun reportCameraStatus(
        @Path("deviceId") deviceId: String,
        @Header("x-api-key") apiKey: String,
        @Body body: RemoteScreenStatusRequest
    ): Response<Any>

    @GET("gateway/devices/{deviceId}/remote-camera/commands")
    suspend fun pollCameraCommands(
        @Path("deviceId") deviceId: String,
        @Header("x-api-key") apiKey: String,
        @Query("sessionId") sessionId: String,
        @Query("wait") wait: Int = 1
    ): Response<RemoteScreenFrameResponse>
}

/** Own client: the command long-poll outlives OkHttp's default 10s read timeout. */
object RemoteScreenApi {
    @Volatile
    private var instance: RemoteScreenApiService? = null

    fun get(): RemoteScreenApiService =
        instance ?: synchronized(this) {
            instance ?: Retrofit.Builder()
                .baseUrl(AppConstants.API_BASE_URL)
                .client(
                    LegacyTls.okHttpClient().newBuilder()
                        .readTimeout(25, TimeUnit.SECONDS)
                        .writeTimeout(20, TimeUnit.SECONDS)
                        .build()
                )
                .addConverterFactory(GsonConverterFactory.create())
                .build()
                .create(RemoteScreenApiService::class.java)
                .also { instance = it }
        }
}
