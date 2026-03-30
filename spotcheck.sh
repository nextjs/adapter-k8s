npm run build &&
npm pack . &&
cd ../../test-app &&
npm i --save-dev ../nextjs/adapter-k8s/next-community-adapter-k8s-0.0.0.tgz &&
npx @next-community/adapter-k8s init --project-id praxis-road-491306-c0 --host adapter-gke.jamesdaniels.net &&
npx @next-community/adapter-k8s deploy &&
echo "Waiting 120s for LB to fully propagate..." &&
sleep 120 &&
npx @next-community/adapter-k8s doctor || true
npx @next-community/adapter-k8s describe &&
curl -s -o /dev/null -w "\nHTTP %{http_code} from %{remote_ip}\n" https://adapter-gke.jamesdaniels.net &&
curl -s https://adapter-gke.jamesdaniels.net | head -c 200
