package com.safepocket.ledger.rag;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.LocalDate;
import java.util.List;
import org.junit.jupiter.api.Test;

class CsvCompressorTest {

    @Test
    void toCsvFormatsRows() {
        List<TxRow> rows = List.of(
                new TxRow("t1", LocalDate.of(2025, 9, 15), "m1", 460, "eo"),
                new TxRow("t2", LocalDate.of(2025, 9, 18), "m1", 380, "eo")
        );
        String csv = CsvCompressor.toCsv(rows);
        assertThat(csv).isEqualTo("t1,250915,m1,460,eo\nt2,250918,m1,380,eo");
    }

    @Test
    void shortCategoryFallsBack() {
        assertThat(CsvCompressor.shortCategory("Travel")).isEqualTo("tv");
        assertThat(CsvCompressor.shortCategory("X")).isEqualTo("xx");
        assertThat(CsvCompressor.shortCategory("")).isEqualTo("ot");
    }
}
