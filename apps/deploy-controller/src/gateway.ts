import { boundedServer, gatewayHandler } from './http.ts'
const socket = process.env.TICKIT_DEPLOY_SOCKET ?? '/run/tickit-deploy/worker.sock'
boundedServer(gatewayHandler(socket)).listen(8080, '0.0.0.0')
