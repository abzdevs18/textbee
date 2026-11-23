package com.vernu.sms.dtos

/** Upload body. Gson drops nulls, so an unchanged screen is sent as just the session id. */
class RemoteScreenFrameRequest(
    val sessionId: String,
    val width: Int? = null,
    val height: Int? = null,
    val image: String? = null,
    /** Increasing per session; lets the server drop frames that arrive late. */
    val seq: Long? = null
)

class RemoteScreenStatusRequest(
    val sessionId: String,
    val state: String,
    val message: String? = null
)

/** Coordinates are 0..1 of the frame. */
class RemoteScreenCommand {
    var type: String? = null
    var x: Double? = null
    var y: Double? = null
    var x1: Double? = null
    var y1: Double? = null
    var x2: Double? = null
    var y2: Double? = null
    var durationMs: Long? = null
    /** global: back/home/…; camera: switch/rotate. */
    var action: String? = null
}

class RemoteScreenFrameData {
    var active: Boolean = false
    var commands: List<RemoteScreenCommand>? = null
}

class RemoteScreenFrameResponse {
    var data: RemoteScreenFrameData? = null
}
