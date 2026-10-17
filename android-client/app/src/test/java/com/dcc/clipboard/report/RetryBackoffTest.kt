package com.dcc.clipboard.report

import org.junit.Assert.assertEquals
import org.junit.Test

class RetryBackoffTest {
    @Test
    fun `delay doubles for first attempts and caps at five minutes`() {
        assertEquals(1L, RetryBackoff.delaySeconds(0))
        assertEquals(2L, RetryBackoff.delaySeconds(1))
        assertEquals(4L, RetryBackoff.delaySeconds(2))
        assertEquals(8L, RetryBackoff.delaySeconds(3))
        assertEquals(16L, RetryBackoff.delaySeconds(4))
        assertEquals(300L, RetryBackoff.delaySeconds(30))
        assertEquals(300L, RetryBackoff.delaySeconds(100))
    }
}
