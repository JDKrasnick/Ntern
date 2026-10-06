output "d1_database_id" {
  value = cloudflare_d1_database.application.id
}

output "documents_bucket_name" {
  value = cloudflare_r2_bucket.documents.name
}

output "worker_name" {
  value = cloudflare_workers_script.application.script_name
}

output "ingestion_worker_name" {
  value = cloudflare_workers_script.ingestion.script_name
}

output "queue_names" {
  value = { for provider, queue in cloudflare_queue.work : provider => queue.queue_name }
}

output "isolated_worker_names" {
  value = { for role, worker in cloudflare_workers_script.isolated : role => worker.script_name }
}
