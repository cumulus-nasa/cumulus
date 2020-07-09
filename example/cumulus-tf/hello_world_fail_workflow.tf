module "hello_world_fail_workflow" {
  source = "../../tf-modules/workflow"

  prefix          = var.prefix
  name            = "HelloWorldFailWorkflow"
  workflow_config = module.cumulus.workflow_config
  system_bucket   = var.system_bucket
  tags            = local.tags


  state_machine_definition = templatefile(
    "${path.module}/hello_world_fail_workflow.asl.json",
    {
      hello_world_task_arn: module.cumulus.hello_world_task.task_arn
    }
  )
}
