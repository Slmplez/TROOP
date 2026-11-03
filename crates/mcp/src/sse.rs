//! Byte framing precedes UTF-8 decoding; CR, LF, CRLF and multiline data are supported.
use super::LIMIT;
#[derive(Default)]
pub struct Decoder {
    line: Vec<u8>,
    data: String,
    event: String,
    cr: bool,
}
pub struct Event {
    pub name: String,
    pub data: String,
}
impl Decoder {
    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<Event>, String> {
        let mut events = vec![];
        for &b in bytes {
            if self.cr {
                self.cr = false;
                if b == b'\n' {
                    continue;
                }
            }
            if b == b'\r' || b == b'\n' {
                self.cr = b == b'\r';
                let line = std::str::from_utf8(&self.line).map_err(|_| "Invalid SSE UTF-8")?;
                if line.is_empty() {
                    if !self.data.is_empty() {
                        self.data.pop();
                        events.push(Event {
                            name: std::mem::take(&mut self.event),
                            data: std::mem::take(&mut self.data),
                        });
                    }
                    self.event.clear();
                } else if let Some(data) = line.strip_prefix("data:") {
                    self.data.push_str(data.strip_prefix(' ').unwrap_or(data));
                    self.data.push('\n');
                } else if let Some(event) = line.strip_prefix("event:") {
                    self.event = event.strip_prefix(' ').unwrap_or(event).to_owned();
                }
                self.line.clear();
            } else {
                self.line.push(b);
            }
            if self.line.len() + self.data.len() + self.event.len() > LIMIT {
                return Err("MCP event exceeds size limit".into());
            }
        }
        Ok(events)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unicode_and_mixed_newlines_survive_byte_splits() {
        let mut d = Decoder::default();
        let mut all = vec![];
        for b in "event: message\rdata: 中文\r\ndata: second\n\n".as_bytes() {
            all.extend(d.push(&[*b]).unwrap());
        }
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].name, "message");
        assert_eq!(all[0].data, "中文\nsecond");
    }
    #[test]
    fn cumulative_lines_cannot_escape_limit() {
        let mut d = Decoder::default();
        assert!(d
            .push(
                format!(
                    "data: {}\ndata: {}\n",
                    "x".repeat(LIMIT / 2),
                    "x".repeat(LIMIT / 2)
                )
                .as_bytes()
            )
            .is_err());
    }
    #[test]
    fn comments_and_empty_events_do_not_make_responses() {
        let mut d = Decoder::default();
        assert!(d
            .push(b": heartbeat\n\nevent: message\n\n")
            .unwrap()
            .is_empty());
        assert!(d
            .push(&[b'd', b'a', b't', b'a', b':', 0xff, b'\n'])
            .is_err());
    }
}
