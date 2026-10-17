package com.dcc.clipboard.sms

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SmsFingerprintTest {

    private val base = AssembledSms(
        sender = "13800138000",
        body = "验证码 839201",
        timestampMillis = 1_700_000_000_000,
        subscriptionId = 1,
        segmentCount = 2,
    )

    @Test
    fun `same message produces the same fingerprint`() {
        assertEquals(SmsFingerprint.of(base), SmsFingerprint.of(base.copy()))
    }

    @Test
    fun `content changes produce a different fingerprint`() {
        assertNotEquals(SmsFingerprint.of(base), SmsFingerprint.of(base.copy(body = "验证码 111111")))
    }

    @Test
    fun `sender timestamp and subscription are part of the identity`() {
        assertNotEquals(SmsFingerprint.of(base), SmsFingerprint.of(base.copy(sender = "95588")))
        assertNotEquals(
            SmsFingerprint.of(base),
            SmsFingerprint.of(base.copy(timestampMillis = base.timestampMillis + 1)),
        )
        assertNotEquals(
            SmsFingerprint.of(base),
            SmsFingerprint.of(base.copy(subscriptionId = 2)),
        )
    }

    @Test
    fun `fingerprint is a sha256 hex string`() {
        val fingerprint = SmsFingerprint.of(base)
        assertEquals(64, fingerprint.length)
        assertTrue(fingerprint.matches(Regex("[0-9a-f]{64}")))
    }
}
