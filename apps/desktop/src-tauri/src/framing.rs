use std::io::{self, BufRead};

// Must match packages/muse-bridge/src/framing.ts. Excludes the newline.
pub const MAX_FRAME_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_LOG_BYTES: usize = 8 * 1024;

/// Bound allocation before reading an unterminated line. Oversized protocol
/// frames fail closed; diagnostic lines are drained with only a prefix retained.
pub fn read_line<R: BufRead>(reader: &mut R, limit: usize, truncate: bool) -> io::Result<Option<String>> {
    let mut line = Vec::new();
    let mut truncated = false;
    loop {
        // A signal may interrupt the blocking read (EINTR) after consuming
        // nothing; retry rather than ending the relay over it.
        let chunk = match reader.fill_buf() {
            Err(err) if err.kind() == io::ErrorKind::Interrupted => continue,
            result => result?,
        };
        if chunk.is_empty() {
            if line.is_empty() && !truncated {
                return Ok(None);
            }
            break;
        }
        let newline = chunk.iter().position(|byte| *byte == b'\n');
        let length = newline.unwrap_or(chunk.len());
        let keep = length.min(limit - line.len());
        if keep < length {
            if !truncate {
                return Err(io::Error::new(io::ErrorKind::InvalidData, "Protocol frame exceeds the byte limit"));
            }
            truncated = true;
        }
        line.extend_from_slice(&chunk[..keep]);
        reader.consume(length + usize::from(newline.is_some()));
        if newline.is_some() {
            break;
        }
    }
    let mut text = String::from_utf8_lossy(&line).into_owned();
    if truncated {
        text.push_str(" [truncated]");
    }
    Ok(Some(text))
}

/// Consume the remainder of one line, retaining nothing: used after a
/// non-truncating read failed on an oversized frame, so the relay can skip
/// that one frame and keep reading instead of dying with the stream.
pub fn drain_line<R: BufRead>(reader: &mut R) -> io::Result<()> {
    read_line(reader, 0, true).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufReader, Cursor};

    #[test]
    fn frames_handle_boundaries_and_eof() {
        let mut reader = BufReader::with_capacity(2, Cursor::new("éxy\n\nend"));
        assert_eq!(read_line(&mut reader, 4, false).unwrap().as_deref(), Some("éxy"));
        assert_eq!(read_line(&mut reader, 4, false).unwrap().as_deref(), Some(""));
        assert_eq!(read_line(&mut reader, 4, false).unwrap().as_deref(), Some("end"));
        assert!(read_line(&mut reader, 4, false).unwrap().is_none());
    }

    #[test]
    fn oversized_frames_fail_before_consuming_unbounded_input() {
        for bytes in [b"12345".as_slice(), b"12345\nok\n".as_slice()] {
            let mut reader = BufReader::with_capacity(2, Cursor::new(bytes));
            assert_eq!(read_line(&mut reader, 4, false).unwrap_err().kind(), io::ErrorKind::InvalidData);
        }
    }

    #[test]
    fn an_oversized_frame_can_be_drained_and_reading_continues() {
        let mut reader = BufReader::with_capacity(2, Cursor::new("123456789\nok\n"));
        assert_eq!(read_line(&mut reader, 4, false).unwrap_err().kind(), io::ErrorKind::InvalidData);
        drain_line(&mut reader).expect("drain");
        assert_eq!(read_line(&mut reader, 4, false).unwrap().as_deref(), Some("ok"));
        assert!(read_line(&mut reader, 4, false).unwrap().is_none());
    }

    #[test]
    fn oversized_logs_are_drained_and_next_line_survives() {
        let mut reader = BufReader::with_capacity(2, Cursor::new("123456789\nok\n"));
        assert_eq!(read_line(&mut reader, 4, true).unwrap().as_deref(), Some("1234 [truncated]"));
        assert_eq!(read_line(&mut reader, 4, true).unwrap().as_deref(), Some("ok"));
    }

    #[test]
    fn interrupted_reads_are_retried() {
        struct InterruptOnce { pending: bool, data: &'static [u8] }
        impl io::Read for InterruptOnce {
            fn read(&mut self, _buf: &mut [u8]) -> io::Result<usize> { Ok(0) }
        }
        impl io::BufRead for InterruptOnce {
            fn fill_buf(&mut self) -> io::Result<&[u8]> {
                if self.pending {
                    self.pending = false;
                    return Err(io::Error::new(io::ErrorKind::Interrupted, "signal"));
                }
                Ok(self.data)
            }
            fn consume(&mut self, amount: usize) { self.data = &self.data[amount..]; }
        }
        let mut reader = InterruptOnce { pending: true, data: b"line\n" };
        // The interruption consumed nothing: the same read then completes.
        assert_eq!(read_line(&mut reader, 64, false).unwrap().as_deref(), Some("line"));
        assert!(read_line(&mut reader, 64, false).unwrap().is_none());
    }
}
