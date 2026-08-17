#!/bin/bash
sshpass -p "ubuntu1400" ssh -o StrictHostKeyChecking=no user603@94.182.92.142 "echo ubuntu1400 | sudo -S docker exec syncpage-rabbitmq-1 rabbitmqctl purge_queue landing.sync.1b660bf3"
sshpass -p "ubuntu1400" ssh -o StrictHostKeyChecking=no user603@94.182.92.142 "echo ubuntu1400 | sudo -S docker exec syncpage-rabbitmq-1 rabbitmqctl purge_queue landing.sync.cbebd0e4"
sshpass -p "ubuntu1400" ssh -o StrictHostKeyChecking=no user603@94.182.92.142 "echo ubuntu1400 | sudo -S docker exec syncpage-rabbitmq-1 rabbitmqctl purge_queue landing.sync"
