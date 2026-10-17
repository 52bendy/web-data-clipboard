package com.dcc.clipboard.network

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CollectResponseParserTest {
    @Test
    fun `parses a successful collect envelope`() {
        val result = CollectResponseParser.parse(
            httpStatus = 200,
            body = """
                {"code":200,"message":"Data collected successfully","data":{
                "collection_id":"col_1728950400000123456","extracted_code":"123456",
                "clipboard_updated":true}}
            """.trimIndent(),
        )

        assertTrue(result is TestConnectionResult.Success)
        result as TestConnectionResult.Success
        assertEquals("col_1728950400000123456", result.collectionId)
        assertEquals("123456", result.extractedCode)
        assertTrue(result.clipboardUpdated)
    }

    @Test
    fun `treats a null extracted code as absent`() {
        val result = CollectResponseParser.parse(
            httpStatus = 200,
            body = """{"code":200,"message":"ok","data":{"collection_id":"col_1","extracted_code":null}}""",
        )

        result as TestConnectionResult.Success
        assertNull(result.extractedCode)
        assertEquals("col_1", result.collectionId)
    }

    @Test
    fun `returns the server message for rejected requests`() {
        val result = CollectResponseParser.parse(
            httpStatus = 401,
            body = """{"code":401,"message":"Unauthorized","data":null}""",
        )

        result as TestConnectionResult.Rejected
        assertEquals(401, result.httpStatus)
        assertEquals("Unauthorized", result.serverMessage)
    }

    @Test
    fun `handles non json error bodies without crashing`() {
        val result = CollectResponseParser.parse(502, "<html>bad gateway</html>")

        result as TestConnectionResult.Rejected
        assertEquals(502, result.httpStatus)
        assertNull(result.serverMessage)
    }

    @Test
    fun `treats an envelope code other than 200 as a rejection`() {
        val result = CollectResponseParser.parse(
            httpStatus = 200,
            body = """{"code":500,"message":"Internal server error.","data":null}""",
        )

        result as TestConnectionResult.Rejected
        assertEquals("Internal server error.", result.serverMessage)
    }
}
