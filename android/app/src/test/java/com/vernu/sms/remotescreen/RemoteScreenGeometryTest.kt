package com.vernu.sms.remotescreen

import com.vernu.sms.dtos.RemoteScreenCommand
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class RemoteScreenGeometryTest {
    private fun cmd(block: RemoteScreenCommand.() -> Unit) = RemoteScreenCommand().apply(block)

    @Test
    fun tapMapsNormalisedCoordinatesOntoTheScreen() {
        assertEquals(
            RemoteGesture.Tap(540f, 1920f),
            RemoteScreenGeometry.toGesture(cmd { type = "tap"; x = 0.5; y = 0.8 }, 1080, 2400)
        )
    }

    @Test
    fun edgesStayInsideTheScreen() {
        assertEquals(
            RemoteGesture.Tap(1079f, 2399f),
            RemoteScreenGeometry.toGesture(cmd { type = "tap"; x = 1.0; y = 1.0 }, 1080, 2400)
        )
    }

    @Test
    fun swipeDurationIsClamped() {
        val gesture = RemoteScreenGeometry.toGesture(
            cmd { type = "swipe"; x1 = 0.5; y1 = 0.9; x2 = 0.5; y2 = 0.1; durationMs = 60_000 }, 1000, 2000
        )
        assertEquals(RemoteGesture.Swipe(500f, 1800f, 500f, 200f, 3_000L), gesture)
    }

    @Test
    fun rejectsInvalidCommands() {
        assertNull(RemoteScreenGeometry.toGesture(cmd { type = "tap"; x = 1.5; y = 0.5 }, 100, 100))
        assertNull(RemoteScreenGeometry.toGesture(cmd { type = "tap"; x = 0.5 }, 100, 100))
        assertNull(RemoteScreenGeometry.toGesture(cmd { type = "tap"; x = 0.5; y = 0.5 }, 0, 0))
        assertNull(RemoteScreenGeometry.toGesture(cmd { type = "global"; action = "power" }, 100, 100))
        assertNull(RemoteScreenGeometry.toGesture(cmd { type = "shell" }, 100, 100))
        assertEquals(
            RemoteGesture.Global("back"),
            RemoteScreenGeometry.toGesture(cmd { type = "global"; action = "back" }, 100, 100)
        )
    }

    @Test
    fun framesAreScaledToTheMaxEdge() {
        assertEquals(324 to 720, RemoteScreenGeometry.scaledSize(1080, 2400))
        assertEquals(576 to 720, RemoteScreenGeometry.scaledSize(720, 900))
        assertEquals(360 to 640, RemoteScreenGeometry.scaledSize(360, 640))
    }
}
