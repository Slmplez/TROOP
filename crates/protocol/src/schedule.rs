//! Fixed-zone wall-clock slots. Slot identity follows local calendar time so a
//! repeated DST hour has one identity and a missing time remains an auditable skip.
use chrono::{DateTime, Datelike, Duration, LocalResult, NaiveDate, NaiveTime, TimeZone, Utc};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Schedule {
    pub kind: String,
    pub timezone: String,
    pub time: String,
    pub date: Option<String>,
    #[serde(default)]
    pub weekdays: Vec<u32>,
}
#[derive(Clone, Deserialize, Serialize)]
pub struct Slot {
    pub slot_key: String,
    pub timezone: String,
    pub local_date: String,
    pub local_time: String,
    pub due_at_ms: Option<i64>,
    pub at_ms: i64,
    pub state: String,
}
pub fn manual_slot(timezone: &str, now: i64, key: &str) -> Result<Slot, String> {
    let zone = timezone.parse::<Tz>().map_err(|_| "时区无效。")?;
    let date = DateTime::<Utc>::from_timestamp_millis(now)
        .ok_or("时间无效。")?
        .with_timezone(&zone);
    Ok(Slot {
        slot_key: format!("manual:{key}"),
        timezone: zone.to_string(),
        local_date: date.format("%Y-%m-%d").to_string(),
        local_time: date.format("%H:%M:%S").to_string(),
        due_at_ms: Some(now),
        at_ms: now,
        state: "scheduled".into(),
    })
}
impl Schedule {
    fn zone_time(&self) -> Result<(Tz, NaiveTime), String> {
        let zone = self
            .timezone
            .parse::<Tz>()
            .map_err(|_| "请选择有效的 IANA 时区。")?;
        let time = NaiveTime::parse_from_str(&self.time, "%H:%M:%S")
            .or_else(|_| NaiveTime::parse_from_str(&self.time, "%H:%M"))
            .map_err(|_| "时间须为 HH:MM 或 HH:MM:SS。")?;
        Ok((zone, time))
    }
    pub fn validate(&self) -> Result<(), String> {
        self.zone_time()?;
        match self.kind.as_str() {
            "once" => {
                let date = self.date.as_deref().ok_or("请选择一次性提醒日期。")?;
                let date =
                    NaiveDate::parse_from_str(date, "%Y-%m-%d").map_err(|_| "提醒日期无效。")?;
                if !(2000..=2100).contains(&date.year()) || !self.weekdays.is_empty() {
                    return Err("一次性提醒日期或重复设置无效。".into());
                }
            }
            "daily" if self.date.is_none() && self.weekdays.is_empty() => {}
            "weekly"
                if self.date.is_none()
                    && !self.weekdays.is_empty()
                    && self.weekdays.len() <= 7
                    && self.weekdays.iter().all(|day| (1..=7).contains(day)) =>
            {
                let mut days = self.weekdays.clone();
                days.sort_unstable();
                days.dedup();
                if days.len() != self.weekdays.len() {
                    return Err("每周日期不能重复。".into());
                }
            }
            _ => return Err("重复规则无效。".into()),
        }
        Ok(())
    }
    fn on_date(&self, date: NaiveDate) -> Result<Slot, String> {
        let (zone, time) = self.zone_time()?;
        let local = date.and_time(time);
        let resolved = zone.from_local_datetime(&local);
        let due = match resolved {
            LocalResult::Single(value) => Some(value.timestamp_millis()),
            LocalResult::Ambiguous(first, second) => {
                Some(first.timestamp_millis().min(second.timestamp_millis()))
            }
            LocalResult::None => None,
        };
        let at = if let Some(due) = due {
            due
        } else {
            (1..=1440)
                .find_map(|minutes| {
                    match zone.from_local_datetime(&(local + Duration::minutes(minutes))) {
                        LocalResult::Single(value) => Some(value.timestamp_millis()),
                        LocalResult::Ambiguous(first, second) => {
                            Some(first.timestamp_millis().min(second.timestamp_millis()))
                        }
                        LocalResult::None => None,
                    }
                })
                .ok_or("无法解析该时区缺失时刻。")?
        };
        let local_date = date.format("%Y-%m-%d").to_string();
        let local_time = time.format("%H:%M:%S").to_string();
        Ok(Slot {
            slot_key: format!("{local_date}T{local_time}[{zone}]"),
            timezone: zone.to_string(),
            local_date,
            local_time,
            due_at_ms: due,
            at_ms: at,
            state: if due.is_some() {
                "scheduled"
            } else {
                "dst_gap"
            }
            .into(),
        })
    }
    fn eligible(&self, date: NaiveDate) -> bool {
        self.kind != "weekly" || self.weekdays.contains(&date.weekday().number_from_monday())
    }
    pub fn next(&self, after_ms: i64) -> Result<Option<Slot>, String> {
        self.validate()?;
        let after = DateTime::<Utc>::from_timestamp_millis(after_ms)
            .filter(|date| after_ms >= 0 && date.year() <= 2100)
            .ok_or("预览时间超出支持范围。")?;
        if self.kind == "once" {
            let date = NaiveDate::parse_from_str(self.date.as_deref().unwrap(), "%Y-%m-%d")
                .map_err(|_| "提醒日期无效。")?;
            let slot = self.on_date(date)?;
            return Ok((slot.at_ms > after_ms).then_some(slot));
        }
        let (zone, _) = self.zone_time()?;
        let date = after.with_timezone(&zone).date_naive();
        for offset in 0..=370 {
            let candidate = date + Duration::days(offset);
            if candidate.year() > 2100 {
                return Ok(None);
            }
            if self.eligible(candidate) {
                let slot = self.on_date(candidate)?;
                if slot.at_ms > after_ms {
                    return Ok(Some(slot));
                }
            }
        }
        Ok(None)
    }
    pub fn following(&self, previous: &Slot) -> Result<Option<Slot>, String> {
        if self.kind == "once" {
            return Ok(None);
        }
        let date = NaiveDate::parse_from_str(&previous.local_date, "%Y-%m-%d")
            .map_err(|_| "触发槽位日期无效。")?;
        for offset in 1..=7 {
            let candidate = date + Duration::days(offset);
            if candidate.year() > 2100 {
                return Ok(None);
            }
            if self.eligible(candidate) {
                return self.on_date(candidate).map(Some);
            }
        }
        Ok(None)
    }
}
