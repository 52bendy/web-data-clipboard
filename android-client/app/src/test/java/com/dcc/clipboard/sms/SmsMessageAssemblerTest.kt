package com.dcc.clipboard.sms

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SmsMessageAssemblerTest {

    @Test
    fun `single segment is returned as is`() {
        val message = SmsMessageAssembler.assemble(
            listOf(SmsSegment("10086", "验证码 1234", 1_700_000_000_000, 1)),
        )

        assertEquals("10086", message?.sender)
        assertEquals("验证码 1234", message?.body)
        assertEquals(1_700_000_000_000, message?.timestampMillis)
        assertEquals(1, message?.segmentCount)
    }

    @Test
    fun `multipart segments are concatenated in order`() {
        val message = SmsMessageAssembler.assemble(
            listOf(
                SmsSegment("13800138000", "【中国移动】您的验证码是：", 1_700_000_000_000, 2),
                SmsSegment("13800138000", "839201，5分钟内", 1_700_000_000_000, 2),
                SmsSegment("13800138000", "有效。", 1_700_000_000_000, 2),
            ),
        )

        assertEquals("【中国移动】您的验证码是：839201，5分钟内有效。", message?.body)
        assertEquals(3, message?.segmentCount)
        assertEquals(2, message?.subscriptionId)
    }

    @Test
    fun `segments are ordered by timestamp when an OEM reorders the array`() {
        val message = SmsMessageAssembler.assemble(
            listOf(
                SmsSegment("10086", "world", 1_700_000_000_002, 0),
                SmsSegment("10086", "hello ", 1_700_000_000_001, 0),
            ),
        )

        assertEquals("hello world", message?.body)
        assertEquals(1_700_000_000_002, message?.timestampMillis)
    }

    @Test
    fun `sender falls back to the first non blank segment`() {
        val message = SmsMessageAssembler.assemble(
            listOf(
                SmsSegment("", "part1", 1, 0),
                SmsSegment("95588", "part2", 2, 0),
            ),
        )

        assertEquals("95588", message?.sender)
    }

    @Test
    fun `empty segment list yields null`() {
        assertNull(SmsMessageAssembler.assemble(emptyList()))
    }
}
