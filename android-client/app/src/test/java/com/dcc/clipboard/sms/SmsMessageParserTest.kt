package com.dcc.clipboard.sms

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SmsMessageParserTest {

    @Test
    fun `format is forwarded to the platform decoder`() {
        val formats = mutableListOf<String?>()
        val decoder = SmsPduDecoder { _, format ->
            formats.add(format)
            DecodedPdu("10086", "body", 1_700_000_000_000)
        }

        SmsMessageParser.parseSegments(
            pdus = listOf(byteArrayOf(1), byteArrayOf(2)),
            format = "3gpp2",
            decoder = decoder,
        )

        assertEquals(listOf("3gpp2", "3gpp2"), formats)
    }

    @Test
    fun `all pdus are decoded in order`() {
        val decoder = SmsPduDecoder { pdu, _ ->
            DecodedPdu("13800138000", "part${pdu[0].toInt()}", 1_700_000_000_000)
        }

        val segments = SmsMessageParser.parseSegments(
            pdus = listOf(byteArrayOf(1), byteArrayOf(2), byteArrayOf(3)),
            format = "3gpp",
            decoder = decoder,
        )

        assertEquals(3, segments.size)
        assertEquals(listOf("part1", "part2", "part3"), segments.map { it.body })
    }

    @Test
    fun `malformed pdu is skipped and the rest survives`() {
        val decoder = SmsPduDecoder { pdu, _ ->
            if (pdu[0].toInt() == 2) {
                throw IllegalArgumentException("bad pdu")
            }
            DecodedPdu("10086", "part${pdu[0].toInt()}", 1_700_000_000_000)
        }

        val segments = SmsMessageParser.parseSegments(
            pdus = listOf(byteArrayOf(1), byteArrayOf(2), byteArrayOf(3)),
            format = "3gpp",
            decoder = decoder,
        )

        assertEquals(listOf("part1", "part3"), segments.map { it.body })
    }

    @Test
    fun `subscription id is attached to every segment`() {
        val decoder = SmsPduDecoder { _, _ ->
            DecodedPdu("10086", "body", 1_700_000_000_000)
        }

        val segments = SmsMessageParser.parseSegments(
            pdus = listOf(byteArrayOf(1), byteArrayOf(2)),
            format = "3gpp",
            fallbackSubscriptionId = 7,
            decoder = decoder,
        )

        assertTrue(segments.all { it.subscriptionId == 7 })
    }
}
