use bytes::Bytes;
use http_body_util::{BodyExt, Full, Limited};
use hyper::{body::Incoming, service::service_fn, Request, Response};
use hyper_util::rt::{TokioIo, TokioTimer};
use serde_json::{json, Value};
use std::{convert::Infallible, net::SocketAddr, sync::Arc, time::Duration};
use tokio::{
    net::TcpListener,
    sync::{mpsc, oneshot, Semaphore},
    task::{JoinHandle, JoinSet},
};

pub struct Message {
    pub method: String,
    pub path: String,
    pub headers: hyper::HeaderMap,
    pub body: Vec<u8>,
    pub answer: oneshot::Sender<(u16, Value)>,
}
pub struct Receiver {
    pub address: Option<String>,
    pub messages: mpsc::Receiver<Message>,
    task: Option<JoinHandle<()>>,
}
impl Drop for Receiver {
    fn drop(&mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}
impl Receiver {
    pub async fn start(address: Option<SocketAddr>) -> Result<Self, String> {
        let (sender, messages) = mpsc::channel(32);
        let Some(address) = address else {
            return Ok(Self {
                address: None,
                messages,
                task: None,
            });
        };
        if !address.ip().is_loopback() {
            return Err("接收器当前仅绑定 loopback，请通过受控 HTTPS 入口部署。".into());
        }
        let listener = TcpListener::bind(address)
            .await
            .map_err(|e| e.to_string())?;
        let address = Some(format!(
            "http://{}",
            listener.local_addr().map_err(|e| e.to_string())?
        ));
        let task = tokio::spawn(async move {
            let slots = Arc::new(Semaphore::new(8));
            let mut connections = JoinSet::new();
            loop {
                tokio::select! {
                    accepted=listener.accept()=>{
                        let Ok((stream,_))=accepted else{break;};
                        let Ok(slot)=slots.clone().try_acquire_owned() else{continue;};
                        let sender=sender.clone();
                        connections.spawn(async move {
                            let _slot=slot;
                            let service=service_fn(move |request|process(request,sender.clone()));
                            let mut builder=hyper::server::conn::http1::Builder::new();
                            builder.keep_alive(false).max_buf_size(8192).timer(TokioTimer::new()).header_read_timeout(Duration::from_secs(5));
                            let _=tokio::time::timeout(Duration::from_secs(10),builder.serve_connection(TokioIo::new(stream),service)).await;
                        });
                    },
                    Some(_)=connections.join_next()=>{},
                }
            }
        });
        Ok(Self {
            address,
            messages,
            task: Some(task),
        })
    }
}
async fn process(
    request: Request<Incoming>,
    sender: mpsc::Sender<Message>,
) -> Result<Response<Full<Bytes>>, Infallible> {
    let (parts, body) = request.into_parts();
    let body =
        match tokio::time::timeout(Duration::from_secs(5), Limited::new(body, 48_000).collect())
            .await
        {
            Ok(Ok(body)) => body.to_bytes().to_vec(),
            _ => return Ok(response(413, json!({"error":"正文超过上限或接收超时。"}))),
        };
    let (answer, received) = oneshot::channel();
    let message = Message {
        method: parts.method.to_string(),
        path: parts.uri.path().to_owned(),
        headers: parts.headers,
        body,
        answer,
    };
    if sender.try_send(message).is_err() {
        return Ok(response(503, json!({"error":"接收队列已满。"})));
    }
    let (status, body) = match tokio::time::timeout(Duration::from_secs(5), received).await {
        Ok(Ok(answer)) => answer,
        _ => (503, json!({"error":"事件尚未确认，请重投。"})),
    };
    Ok(response(status, body))
}
fn response(status: u16, body: Value) -> Response<Full<Bytes>> {
    let mut response = Response::new(Full::new(Bytes::from(body.to_string())));
    *response.status_mut() =
        hyper::StatusCode::from_u16(status).unwrap_or(hyper::StatusCode::INTERNAL_SERVER_ERROR);
    response.headers_mut().insert(
        hyper::header::CONTENT_TYPE,
        hyper::header::HeaderValue::from_static("application/json; charset=utf-8"),
    );
    response
}
