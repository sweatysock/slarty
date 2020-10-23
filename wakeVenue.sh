echo "Useage sh wakeVenue.sh eventId "

for server in $(heroku apps | awk "/zxzyz"$1"/ {print \$1}")
do
	curl $server".herokuapp.com/slartyguts.html"
done

