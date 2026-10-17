package com.dcc.clipboard.sms

import org.junit.Assert.assertEquals
import org.junit.Test

class SenderMaskTest {

    @Test
    fun `mobile number keeps first three and last four digits`() {
        assertEquals("138****8000", SenderMask.mask("13800138000"))
    }

    @Test
    fun `plus eighty six prefix is preserved`() {
        assertEquals("+86138****8000", SenderMask.mask("+8613800138000"))
    }

    @Test
    fun `short service numbers are not masked`() {
        assertEquals("10086", SenderMask.mask("10086"))
        assertEquals("95588", SenderMask.mask("95588"))
    }

    @Test
    fun `blank sender stays blank`() {
        assertEquals("", SenderMask.mask("   "))
    }
}
