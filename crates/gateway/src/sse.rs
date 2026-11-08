//! Incremental SSE framing before UTF-8 decoding, including CR/LF and multi-line data.
pub const LIMIT: usize = 65_536;
#[derive(Default)]
pub struct Decoder {
    line: Vec<u8>,
    data: String,
    event: String,
    after_cr: bool,
}
#[derive(Debug)]
pub struct Event {
    pub event: String,
    pub data: String,
}
impl Decoder {
    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<Event>, String> {
        let mut events = Vec::new();
        for &byte in chunk {
            if self.after_cr {
                self.after_cr = false;
                if byte == b'\n' {
                    continue;
                }
            }
            if byte == b'\n' || byte == b'\r' {
                self.after_cr = byte == b'\r';
                let line = std::str::from_utf8(&self.line).map_err(|_| "流数据包含无效 UTF-8。")?;
                if line.is_empty() {
                    if !self.data.is_empty() {
                        self.data.pop();
                        events.push(Event {
                            event: std::mem::take(&mut self.event),
                            data: std::mem::take(&mut self.data),
                        });
                    }
                    self.event.clear();
                } else if let Some(data) = line.strip_prefix("data:") {
                    self.data.push_str(data.strip_prefix(' ').unwrap_or(data));
                    self.data.push('\n');
                } else if let Some(event) = line.strip_prefix("event:") {
                    self.event = event.trim_start().to_owned();
                }
                self.line.clear();
            } else {
                self.line.push(byte);
            }
            if self.line.len() + self.data.len() + self.event.len() > LIMIT {
                return Err("流事件超过 64 KiB 限制。".into());
            }
        }
        Ok(events)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn split_unicode_crlf_and_multiline_data() {
        let mut d = Decoder::default();
        let mut events = Vec::new();
        for byte in "event: delta\r\ndata: 中文\r\ndata: two\r\n\r\n".as_bytes() {
            events.extend(d.push(&[*byte]).unwrap());
        }
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event, "delta");
        assert_eq!(events[0].data, "中文\ntwo");
    }
    #[test]
    fn endless_line_is_bounded() {
        assert!(Decoder::default().push(&vec![b'x'; LIMIT + 1]).is_err());
    }
}
