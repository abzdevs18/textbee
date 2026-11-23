package com.vernu.sms.remotescreen

import android.util.Size
import org.junit.Assert.assertNull
import org.junit.Test

class CameraStreamerTest {
    @Test
    fun noSizesMeansNoStream() {
        assertNull(CameraStreamer.chooseSize(emptyList<Size>()))
    }
}
